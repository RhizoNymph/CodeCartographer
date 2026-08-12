/**
 * A run-latest scheduler for work that cannot be aborted mid-flight.
 *
 * elkjs runs in a single web worker and offers no cancellation, so ten rapid
 * clicks used to mean ten sequential full layouts (each with its own IPC round
 * trip) even though only the last one mattered. Coalescing is the right tool:
 * while a run is in flight, every further request collapses into ONE pending
 * rerun carrying the latest inputs (see `merge`), which then runs exactly once.
 *
 * Dependency-free on purpose so it can be unit-tested with a fake runner.
 */
export interface CoalescingSchedulerOptions<Req> {
  /** Perform one request. The scheduler serialises these; never called re-entrantly. */
  run: (request: Req) => Promise<void>;
  /**
   * Fold a newly arrived request into the one already queued. Called only while
   * a run is in flight and something is already pending.
   */
  merge: (pending: Req, next: Req) => Req;
  /** Reported when `run` rejects; the queue keeps draining either way. */
  onError?: (error: unknown) => void;
}

export class CoalescingScheduler<Req> {
  private running = false;
  private pending: Req | null = null;
  private readonly options: CoalescingSchedulerOptions<Req>;

  constructor(options: CoalescingSchedulerOptions<Req>) {
    this.options = options;
  }

  /** Whether a run is currently in flight. */
  get isRunning(): boolean {
    return this.running;
  }

  /** The single coalesced request waiting for the in-flight run to finish. */
  get pendingRequest(): Req | null {
    return this.pending;
  }

  /**
   * Request a run. Runs immediately when idle; otherwise coalesces into the
   * pending rerun.
   */
  schedule(request: Req): void {
    if (this.running) {
      this.pending =
        this.pending === null
          ? request
          : this.options.merge(this.pending, request);
      return;
    }
    void this.runNow(request);
  }

  /** Drop the queued rerun (e.g. on teardown). The in-flight run is unaffected. */
  clearPending(): void {
    this.pending = null;
  }

  private async runNow(request: Req): Promise<void> {
    this.running = true;
    try {
      await this.options.run(request);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      const next = this.pending;
      this.pending = null;
      if (next !== null) {
        void this.runNow(next);
      }
    }
  }
}
