import type { CodeGraph, EdgeKind } from "../../api/types";
import type { LayoutResult } from "./layoutTypes";
import {
  mergeLayoutRequests,
  type EdgeLayoutRequest,
  type FullLayoutRequest,
  type LayoutRequest,
} from "./layoutRequest.ts";
import { CoalescingScheduler } from "./layoutScheduler.ts";

/**
 * The layout-request lifecycle: what to run, what is stale, what to re-apply.
 *
 * The renderer used to carry this state machine inline, which layered three
 * overlapping staleness mechanisms on top of the coalescing queue and made none
 * of them testable. They all live here instead:
 *
 *   - the run-latest QUEUE (`CoalescingScheduler` + `mergeLayoutRequests`), so a
 *     burst of interactions costs one pass with the newest inputs;
 *   - the request-id STALE GUARD, so a superseded pass can neither publish its
 *     edge-kind counts nor overwrite a newer layout;
 *   - the pending GATE, which suppresses the cheap visibility redraw while a
 *     layout is in flight (routing a new visible set against the outgoing layout
 *     is wasted work) and is released even when the layout FAILS;
 *   - the latest-vs-applied VISIBLE SET reconciliation, so a slow layout can
 *     never resurrect nodes the user has hidden meanwhile.
 *
 * Everything the machine actually *does* -- run ELK, touch node displays, draw
 * edges, publish to stores -- is injected as `LayoutOrchestratorEffects`, so the
 * module stays free of runtime imports beyond the two pure layout modules and is
 * unit-testable with fakes.
 */

/** Per-kind view counts carried by a layout result. */
type EdgeKindCounts = LayoutResult["edgeKindCounts"];

/**
 * The side effects the orchestrator drives. The renderer supplies the real ones;
 * tests supply fakes.
 */
export interface LayoutOrchestratorEffects {
  /**
   * Resolve once the consumer can accept a layout, reporting whether it still
   * can (false after teardown). Every pass awaits this before doing any work.
   */
  waitUntilReady(): Promise<boolean>;

  /** Run the POSITIONS phase (ELK + view-edge fetch). */
  runFullLayout(request: FullLayoutRequest): Promise<LayoutResult>;

  /** Run the EDGES phase against a previous layout's positions and render set. */
  runEdgePhase(
    previous: LayoutResult,
    enabledEdgeKinds: Set<EdgeKind>,
    hideAmbiguousEdges: boolean
  ): Promise<LayoutResult>;

  /**
   * Adopt the inputs of a full layout that is about to run. Called BEFORE the
   * layout, unguarded, because the consumer needs the new graph (and anything
   * derived from it) for interaction handling even while the pass is in flight.
   */
  adoptFullLayoutInputs(request: FullLayoutRequest): void;

  /**
   * Apply a fresh, current full layout: rebuild the node displays at the new
   * positions and perform exactly ONE full edge rebuild.
   */
  applyFullLayout(layout: LayoutResult, request: FullLayoutRequest): void;

  /** Apply a fresh, current edge-phase layout: edges only, camera untouched. */
  applyEdgeLayout(layout: LayoutResult, request: EdgeLayoutRequest): void;

  /** Flip the already-laid-out node displays to a visible set. Draws no edges. */
  applyVisibleNodes(visibleNodes: Set<string>): void;

  /** Redraw the edges against the displays as they stand. */
  redrawEdges(): void;

  /** Publish the legend's per-kind counts for a pass known to be current. */
  publishEdgeKindCounts(counts: EdgeKindCounts): void;

  /** Report a failed pass. The gate is already released when this is called. */
  reportError(error: unknown): void;
}

export class LayoutOrchestrator {
  private readonly effects: LayoutOrchestratorEffects;

  /**
   * Monotonic id of the newest STARTED pass. A completing pass whose id is no
   * longer the newest has been superseded and discards its result.
   */
  private requestId = 0;

  /** True between requesting a full layout and applying it (or failing). */
  private pending = false;

  /** The result of the newest applied pass; the edges phase's input. */
  private layout: LayoutResult | null = null;

  /** The visible set currently applied to the displays. */
  private appliedVisibleNodes: Set<string> = new Set();

  /**
   * The newest visible set handed to the orchestrator, by either a layout
   * request or a visibility update. A layout that started before a later
   * visibility change re-applies this on completion.
   */
  private latestVisibleNodes: Set<string> = new Set();

  private destroyed = false;

  /**
   * Run-latest layout queue. elkjs cannot be aborted mid-run, so a burst of
   * interactions collapses into ONE rerun with the latest inputs instead of a
   * serial pile of full layouts (see `layoutScheduler`).
   */
  private readonly queue: CoalescingScheduler<LayoutRequest>;

  constructor(effects: LayoutOrchestratorEffects) {
    this.effects = effects;
    this.queue = new CoalescingScheduler<LayoutRequest>({
      run: (request) => this.runRequest(request),
      merge: mergeLayoutRequests,
      onError: (error) => {
        // Never leave the gate stuck: it suppresses the visibility redraw.
        this.pending = false;
        this.effects.reportError(error);
      },
    });
  }

  /** The newest applied layout, or null before the first full layout lands. */
  get lastLayout(): LayoutResult | null {
    return this.layout;
  }

  /** True while a full layout is in flight; the visibility redraw is gated. */
  get isLayoutPending(): boolean {
    return this.pending;
  }

  /** The visible set currently applied to the displays. */
  get visibleNodes(): Set<string> {
    return this.appliedVisibleNodes;
  }

  /**
   * Request the POSITIONS phase: a full layout of the node tree plus the view
   * edges for the resulting render set. Coalesced -- calling this repeatedly
   * costs one layout, with the newest inputs.
   */
  requestFullLayout(
    graph: CodeGraph,
    expandedNodes: Set<string>,
    visibleNodes: Set<string>,
    enabledEdgeKinds: Set<EdgeKind>,
    hideAmbiguousEdges: boolean
  ): void {
    this.latestVisibleNodes = visibleNodes;
    // Gates the cheap visibility redraw until this layout lands (or fails):
    // routing the new visible set against the outgoing layout is wasted work.
    this.pending = true;
    this.queue.schedule({
      phase: "full",
      graph,
      expandedNodes,
      visibleNodes,
      enabledEdgeKinds,
      hideAmbiguousEdges,
    });
  }

  /**
   * Request the EDGES phase: re-fetch the view edges for the last laid-out
   * render set and redraw them on the cached node positions. No-op until a full
   * layout has produced positions -- a full layout is either queued behind this
   * (and absorbs it) or has not been asked for.
   */
  requestEdgePhase(
    enabledEdgeKinds: Set<EdgeKind>,
    hideAmbiguousEdges: boolean
  ): void {
    this.queue.schedule({
      phase: "edges",
      enabledEdgeKinds,
      hideAmbiguousEdges,
    });
  }

  /**
   * Change which nodes are visible without a relayout.
   *
   * While a layout is in flight the edge redraw is skipped: it would route the
   * NEW visible set against the OLD (stale) layout, only to be thrown away
   * moments later when the layout lands. Callers commonly change visibility and
   * layout inputs in the same tick, so this is the normal case.
   */
  setVisibleNodes(visibleNodes: Set<string>): void {
    this.latestVisibleNodes = visibleNodes;
    if (this.appliedVisibleNodes === visibleNodes) return;
    this.appliedVisibleNodes = visibleNodes;

    this.effects.applyVisibleNodes(visibleNodes);

    if (this.pending) return;

    this.effects.redrawEdges();
  }

  /** Drop the queued rerun. The in-flight pass discards its own result. */
  destroy(): void {
    this.destroyed = true;
    this.queue.clearPending();
  }

  /** Perform one queued request. Serialised by `queue`; never re-entrant. */
  private async runRequest(request: LayoutRequest): Promise<void> {
    if (!(await this.effects.waitUntilReady())) return;

    const requestId = ++this.requestId;

    if (request.phase === "edges") {
      await this.runEdgePhase(request, requestId);
      return;
    }
    await this.runFullLayout(request, requestId);
  }

  private async runEdgePhase(
    request: EdgeLayoutRequest,
    requestId: number
  ): Promise<void> {
    const previous = this.layout;
    if (!previous) return;

    const layout = await this.effects.runEdgePhase(
      previous,
      request.enabledEdgeKinds,
      request.hideAmbiguousEdges
    );
    if (this.isStale(requestId)) return;

    this.layout = layout;
    this.effects.publishEdgeKindCounts(layout.edgeKindCounts);
    this.effects.applyEdgeLayout(layout, request);
  }

  private async runFullLayout(
    request: FullLayoutRequest,
    requestId: number
  ): Promise<void> {
    this.effects.adoptFullLayoutInputs(request);

    const layout = await this.effects.runFullLayout(request);
    if (this.isStale(requestId)) return;

    // Adopt the request's visible set only now, so a visibility toggle made
    // while this layout ran keeps applying to the displays on screen.
    this.appliedVisibleNodes = request.visibleNodes;
    this.layout = layout;
    // Published only once the pass is known to be current, so a superseded
    // fetch cannot clobber fresh counts.
    this.effects.publishEdgeKindCounts(layout.edgeKindCounts);
    this.effects.applyFullLayout(layout, request);
    // Cleared BEFORE the late-visibility re-apply below, so that redraw is not
    // gated by the very layout it follows.
    this.pending = false;

    // A visibility toggle that landed while this layout was running is applied
    // on top of the fresh displays.
    if (this.latestVisibleNodes !== request.visibleNodes) {
      this.setVisibleNodes(this.latestVisibleNodes);
    }
  }

  /** Whether a completing pass has been superseded (or the consumer is gone). */
  private isStale(requestId: number): boolean {
    return requestId !== this.requestId || this.destroyed;
  }
}
