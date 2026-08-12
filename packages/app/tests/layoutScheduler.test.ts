import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CoalescingScheduler } from "../src/canvas/layout/layoutScheduler.ts";
import {
  mergeLayoutRequests,
  type LayoutRequest,
} from "../src/canvas/layout/layoutRequest.ts";
import type { CodeGraph, EdgeKind } from "../src/api/types.ts";

/** Let every queued microtask (and timer callback) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deferred promise, so tests control exactly when a "layout" finishes. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const emptyGraph: CodeGraph = {
  root: "root",
  edgeCount: 0,
  nodeEdgeKinds: new Map<string, EdgeKind[]>(),
  nodes: {
    root: { type: "Directory", id: "root", name: "repo", path: "", children: [] },
  },
};

function fullRequest(kinds: EdgeKind[], hideAmbiguous = false): LayoutRequest {
  return {
    phase: "full",
    graph: emptyGraph,
    expandedNodes: new Set<string>(),
    visibleNodes: new Set<string>(),
    enabledEdgeKinds: new Set<EdgeKind>(kinds),
    hideAmbiguousEdges: hideAmbiguous,
  };
}

function edgeRequest(kinds: EdgeKind[], hideAmbiguous = false): LayoutRequest {
  return {
    phase: "edges",
    enabledEdgeKinds: new Set<EdgeKind>(kinds),
    hideAmbiguousEdges: hideAmbiguous,
  };
}

describe("CoalescingScheduler", () => {
  it("runs the first request immediately", () => {
    const seen: number[] = [];
    const gate = deferred();
    const scheduler = new CoalescingScheduler<number>({
      run: (n) => {
        seen.push(n);
        return gate.promise;
      },
      merge: (_pending, next) => next,
    });

    scheduler.schedule(1);
    assert.deepEqual(seen, [1]);
    assert.equal(scheduler.isRunning, true);
  });

  it("collapses every request arriving during a run into ONE rerun", async () => {
    const seen: number[] = [];
    let gate = deferred();
    const scheduler = new CoalescingScheduler<number>({
      run: (n) => {
        seen.push(n);
        return gate.promise;
      },
      merge: (_pending, next) => next,
    });

    scheduler.schedule(1);
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) scheduler.schedule(n);
    assert.deepEqual(seen, [1], "queued requests must not run in parallel");

    const first = gate;
    gate = deferred();
    first.resolve();
    await flush();

    // Only the LATEST queued input reran -- 2..9 were coalesced away.
    assert.deepEqual(seen, [1, 10]);

    const second = gate;
    gate = deferred();
    second.resolve();
    await flush();
    assert.deepEqual(seen, [1, 10], "nothing pending -> no further runs");
    assert.equal(scheduler.isRunning, false);
  });

  it("merges queued requests instead of replacing them when asked", async () => {
    const seen: string[] = [];
    const gate = deferred();
    const scheduler = new CoalescingScheduler<string>({
      run: (s) => {
        seen.push(s);
        return gate.promise;
      },
      merge: (pending, next) => `${pending}+${next}`,
    });

    scheduler.schedule("a");
    scheduler.schedule("b");
    scheduler.schedule("c");
    assert.equal(scheduler.pendingRequest, "b+c");

    gate.resolve();
    await flush();
    assert.deepEqual(seen, ["a", "b+c"]);
  });

  it("keeps draining after a failed run and reports the error", async () => {
    const seen: number[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const scheduler = new CoalescingScheduler<number>({
      run: async (n) => {
        seen.push(n);
        if (fail) {
          fail = false;
          throw new Error(`boom ${n}`);
        }
      },
      merge: (_pending, next) => next,
      onError: (err) => errors.push(err),
    });

    scheduler.schedule(1);
    scheduler.schedule(2);
    await flush();

    assert.deepEqual(seen, [1, 2]);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /boom 1/);
    assert.equal(scheduler.isRunning, false);
  });

  it("clearPending drops the queued rerun without disturbing the running one", async () => {
    const seen: number[] = [];
    const gate = deferred();
    const scheduler = new CoalescingScheduler<number>({
      run: (n) => {
        seen.push(n);
        return gate.promise;
      },
      merge: (_pending, next) => next,
    });

    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.clearPending();
    assert.equal(scheduler.pendingRequest, null);

    gate.resolve();
    await flush();
    assert.deepEqual(seen, [1]);
  });
});

describe("mergeLayoutRequests", () => {
  it("a full layout always wins over a queued edge phase", () => {
    const merged = mergeLayoutRequests(
      edgeRequest(["Import"]),
      fullRequest(["FunctionCall"])
    );
    assert.equal(merged.phase, "full");
    assert.deepEqual(Array.from(merged.enabledEdgeKinds), ["FunctionCall"]);
  });

  it("a later full layout replaces an earlier one", () => {
    const merged = mergeLayoutRequests(
      fullRequest(["Import"], true),
      fullRequest(["MethodCall"], false)
    );
    assert.equal(merged.phase, "full");
    assert.deepEqual(Array.from(merged.enabledEdgeKinds), ["MethodCall"]);
    assert.equal(merged.hideAmbiguousEdges, false);
  });

  it("an edge phase queued behind a full layout folds into it (one layout, latest filters)", () => {
    const merged = mergeLayoutRequests(
      fullRequest(["Import"], false),
      edgeRequest(["Import", "TypeReference"], true)
    );
    assert.equal(merged.phase, "full");
    assert.deepEqual(Array.from(merged.enabledEdgeKinds), ["Import", "TypeReference"]);
    assert.equal(merged.hideAmbiguousEdges, true);
    if (merged.phase === "full") {
      assert.equal(merged.graph, emptyGraph);
    }
  });

  it("consecutive edge phases keep only the latest filters", () => {
    const merged = mergeLayoutRequests(
      edgeRequest(["Import"], false),
      edgeRequest(["MethodCall"], true)
    );
    assert.equal(merged.phase, "edges");
    assert.deepEqual(Array.from(merged.enabledEdgeKinds), ["MethodCall"]);
    assert.equal(merged.hideAmbiguousEdges, true);
  });
});
