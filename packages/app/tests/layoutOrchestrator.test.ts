import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LayoutOrchestrator,
  type LayoutOrchestratorEffects,
} from "../src/canvas/layout/layoutOrchestrator.ts";
import type {
  EdgeLayoutRequest,
  FullLayoutRequest,
} from "../src/canvas/layout/layoutRequest.ts";
import type { LayoutResult } from "../src/canvas/layout/layoutTypes.ts";
import type { CodeGraph, EdgeKind } from "../src/api/types.ts";

/** Let every queued microtask (and timer callback) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** A deferred promise, so tests control exactly when a "layout" finishes. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The orchestrator observes the rejection itself; this only stops node from
  // flagging it as unhandled in the tick before it does.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function graphNamed(name: string): CodeGraph {
  return {
    root: name,
    edgeCount: 0,
    nodeEdgeKinds: new Map<string, EdgeKind[]>(),
    nodes: {
      [name]: { type: "Directory", id: name, name, path: "", children: [] },
    },
  };
}

/**
 * Which layout a published `edgeKindCounts` object came from. The counts are
 * opaque to the orchestrator, so the fake identifies them by their owner.
 */
const countsOwner = new WeakMap<object, string>();

function layoutNamed(name: string): LayoutResult {
  const edgeKindCounts: LayoutResult["edgeKindCounts"] = {
    Import: null,
    FunctionCall: null,
    MethodCall: null,
    TypeReference: null,
    Inheritance: null,
    TraitImpl: null,
    VariableUsage: null,
  };
  countsOwner.set(edgeKindCounts, name);
  return { nodes: {}, edges: [], edgeKindCounts, renderIds: [name] };
}

/** A set label, so the event log reads as the inputs the test supplied. */
function label(nodes: Set<string>): string {
  return Array.from(nodes).sort().join("|") || "-";
}

function kindLabel(kinds: Set<EdgeKind>): string {
  return Array.from(kinds).sort().join("|") || "-";
}

interface Harness {
  orchestrator: LayoutOrchestrator;
  /** Ordered log of every effect the orchestrator drove. */
  events: string[];
  fullRequests: FullLayoutRequest[];
  /** The edge-phase requests that were actually APPLIED. */
  appliedEdgeRequests: EdgeLayoutRequest[];
  /** The `previous` layout each edge phase was handed. */
  edgePrevious: LayoutResult[];
  fullGates: Deferred<LayoutResult>[];
  edgeGates: Deferred<LayoutResult>[];
  /** Names of the layouts whose counts reached the legend. */
  published: string[];
  errors: unknown[];
  setReady(ready: boolean): void;
}

function harness(): Harness {
  const events: string[] = [];
  const fullRequests: FullLayoutRequest[] = [];
  const appliedEdgeRequests: EdgeLayoutRequest[] = [];
  const edgePrevious: LayoutResult[] = [];
  const fullGates: Deferred<LayoutResult>[] = [];
  const edgeGates: Deferred<LayoutResult>[] = [];
  const published: string[] = [];
  const errors: unknown[] = [];
  let ready = true;

  const effects: LayoutOrchestratorEffects = {
    waitUntilReady: async () => ready,
    runFullLayout: (request) => {
      fullRequests.push(request);
      events.push(
        `run:full(${request.graph.root},vis=${label(request.visibleNodes)},kinds=${kindLabel(request.enabledEdgeKinds)},amb=${request.hideAmbiguousEdges})`
      );
      const gate = deferred<LayoutResult>();
      fullGates.push(gate);
      return gate.promise;
    },
    runEdgePhase: (previous, enabledEdgeKinds, hideAmbiguousEdges) => {
      edgePrevious.push(previous);
      events.push(
        `run:edges(prev=${previous.renderIds.join(",")},kinds=${kindLabel(enabledEdgeKinds)},amb=${hideAmbiguousEdges})`
      );
      const gate = deferred<LayoutResult>();
      edgeGates.push(gate);
      return gate.promise;
    },
    adoptFullLayoutInputs: (request) => {
      events.push(`adopt(${request.graph.root})`);
    },
    applyFullLayout: (layout, request) => {
      events.push(
        `apply:full(${layout.renderIds.join(",")},vis=${label(request.visibleNodes)})`
      );
    },
    applyEdgeLayout: (layout, request) => {
      appliedEdgeRequests.push(request);
      events.push(`apply:edges(${layout.renderIds.join(",")})`);
    },
    applyVisibleNodes: (visibleNodes) => {
      events.push(`apply:visible(${label(visibleNodes)})`);
    },
    redrawEdges: () => {
      events.push("redraw");
    },
    publishEdgeKindCounts: (counts) => {
      published.push(countsOwner.get(counts) ?? "?");
      events.push("publish");
    },
    reportError: (error) => {
      errors.push(error);
      events.push("error");
    },
  };

  return {
    orchestrator: new LayoutOrchestrator(effects),
    events,
    fullRequests,
    appliedEdgeRequests,
    edgePrevious,
    fullGates,
    edgeGates,
    published,
    errors,
    setReady: (next: boolean) => {
      ready = next;
    },
  };
}

const ALL_NODES = new Set(["a", "b", "c"]);

function requestFull(
  h: Harness,
  graphName: string,
  visible: Set<string>,
  kinds: EdgeKind[] = ["Import"],
  hideAmbiguous = false
): void {
  h.orchestrator.requestFullLayout(
    graphNamed(graphName),
    new Set<string>(),
    visible,
    new Set<EdgeKind>(kinds),
    hideAmbiguous
  );
}

describe("LayoutOrchestrator coalescing", () => {
  it("collapses a burst of full layouts into ONE rerun with the newest inputs", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    assert.deepEqual(h.fullRequests.map((r) => r.graph.root), ["g1"]);

    // Three more arrive while g1 is still solving.
    requestFull(h, "g2", ALL_NODES);
    requestFull(h, "g3", ALL_NODES);
    requestFull(h, "g4", ALL_NODES);
    await flush();
    assert.deepEqual(
      h.fullRequests.map((r) => r.graph.root),
      ["g1"],
      "queued requests must not run in parallel"
    );

    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    // g2 and g3 were coalesced away; only the newest inputs reran.
    assert.deepEqual(h.fullRequests.map((r) => r.graph.root), ["g1", "g4"]);
  });

  it("folds a queued edge phase into the queued full layout, keeping the newest filters", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES, ["Import"]);
    await flush();

    requestFull(h, "g2", ALL_NODES, ["Import"], false);
    h.orchestrator.requestEdgePhase(
      new Set<EdgeKind>(["Import", "TypeReference"]),
      true
    );
    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    assert.equal(h.fullRequests.length, 2);
    const second = h.fullRequests[1]!;
    assert.equal(second.graph.root, "g2", "the full layout dominates");
    assert.deepEqual(
      Array.from(second.enabledEdgeKinds).sort(),
      ["Import", "TypeReference"],
      "but adopts the newer edge filters"
    );
    assert.equal(second.hideAmbiguousEdges, true);
    assert.equal(h.edgePrevious.length, 0, "the edge phase never ran on its own");
  });

  it("keeps only the newest filters across a burst of edge phases", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["Import"]), false);
    await flush();
    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["MethodCall"]), false);
    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["Inheritance"]), true);
    h.edgeGates[0]!.resolve(layoutNamed("L2"));
    await flush();

    assert.equal(h.edgePrevious.length, 2);
    assert.ok(
      h.events.includes("run:edges(prev=L2,kinds=Inheritance,amb=true)"),
      `expected the newest filters to rerun, got ${h.events.join(" ")}`
    );
  });
});

describe("LayoutOrchestrator edges phase", () => {
  it("is a no-op before any full layout has produced positions", async () => {
    const h = harness();

    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["Import"]), false);
    await flush();

    assert.deepEqual(h.edgePrevious, []);
    assert.deepEqual(h.events, [], "nothing to run, nothing to publish");
    assert.equal(h.orchestrator.lastLayout, null);
  });

  it("reuses the previous layout's render set, then adopts its own result", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    const first = layoutNamed("L1");
    h.fullGates[0]!.resolve(first);
    await flush();
    assert.equal(h.orchestrator.lastLayout, first);

    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["MethodCall"]), true);
    await flush();
    assert.deepEqual(h.edgePrevious, [first], "the edge phase runs against L1");

    const second = layoutNamed("L2");
    h.edgeGates[0]!.resolve(second);
    await flush();

    assert.equal(h.orchestrator.lastLayout, second);
    assert.deepEqual(h.published, ["L1", "L2"]);
    assert.deepEqual(
      h.appliedEdgeRequests.map((r) => r.hideAmbiguousEdges),
      [true]
    );

    // A second edge phase reuses the result of the first.
    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["Import"]), false);
    await flush();
    assert.deepEqual(h.edgePrevious, [first, second]);
  });
});

describe("LayoutOrchestrator visibility reconciliation", () => {
  it("applies a fresh layout with exactly one edge rebuild and no late re-apply", async () => {
    const h = harness();
    const visible = new Set(["a", "b"]);

    requestFull(h, "g1", visible);
    await flush();
    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    assert.deepEqual(h.events, [
      "adopt(g1)",
      "run:full(g1,vis=a|b,kinds=Import,amb=false)",
      "publish",
      "apply:full(L1,vis=a|b)",
    ]);
    assert.equal(
      h.events.filter((e) => e === "redraw").length,
      0,
      "applying a layout must not trigger an extra edge redraw"
    );
    assert.equal(h.orchestrator.visibleNodes, visible);
    assert.equal(h.orchestrator.isLayoutPending, false);
  });

  it("re-applies a visibility change that landed while the layout was running", async () => {
    const h = harness();
    const laidOut = new Set(["a", "b", "c"]);
    const narrowed = new Set(["a"]);

    requestFull(h, "g1", laidOut);
    await flush();

    // The user hides two nodes while ELK is still solving.
    h.orchestrator.setVisibleNodes(narrowed);
    assert.ok(
      h.events.includes("apply:visible(a)"),
      "the display flip is immediate"
    );
    assert.equal(
      h.events.filter((e) => e === "redraw").length,
      0,
      "but the edge redraw is gated while the layout is in flight"
    );

    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    assert.deepEqual(h.events, [
      "adopt(g1)",
      "run:full(g1,vis=a|b|c,kinds=Import,amb=false)",
      "apply:visible(a)",
      "publish",
      "apply:full(L1,vis=a|b|c)",
      // The gate is cleared BEFORE this re-apply, so its redraw is not gated.
      "apply:visible(a)",
      "redraw",
    ]);
    assert.equal(
      h.orchestrator.visibleNodes,
      narrowed,
      "a slow layout must not resurrect nodes hidden meanwhile"
    );
  });

  it("redraws edges immediately for a visibility change with no layout in flight", () => {
    const h = harness();
    const first = new Set(["a"]);

    h.orchestrator.setVisibleNodes(first);
    assert.deepEqual(h.events, ["apply:visible(a)", "redraw"]);

    // The same set identity is a no-op: nothing changed on screen.
    h.orchestrator.setVisibleNodes(first);
    assert.deepEqual(h.events, ["apply:visible(a)", "redraw"]);
  });
});

describe("LayoutOrchestrator failure and teardown", () => {
  it("releases the pending gate when the layout FAILS", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    assert.equal(h.orchestrator.isLayoutPending, true);

    h.fullGates[0]!.reject(new Error("elk exploded"));
    await flush();

    assert.equal(h.errors.length, 1);
    assert.match(String(h.errors[0]), /elk exploded/);
    assert.equal(
      h.orchestrator.isLayoutPending,
      false,
      "a stuck gate would silently kill every later visibility redraw"
    );
    assert.equal(h.orchestrator.lastLayout, null, "a failed pass adopts nothing");
    assert.deepEqual(h.published, []);

    // Proof the gate really is open: the cheap path draws again.
    h.orchestrator.setVisibleNodes(new Set(["a"]));
    assert.ok(h.events.includes("redraw"));
  });

  it("keeps draining the queue after a failed pass", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    requestFull(h, "g2", ALL_NODES);
    h.fullGates[0]!.reject(new Error("boom"));
    await flush();

    assert.deepEqual(h.fullRequests.map((r) => r.graph.root), ["g1", "g2"]);
    assert.equal(h.errors.length, 1);
    // The error handler clears the gate unconditionally, so the queued rerun
    // runs ungated. Cosmetic (an extra redraw at worst), and pre-existing.
    assert.equal(h.orchestrator.isLayoutPending, false);
  });

  it("discards a superseded (torn-down) pass: no counts published, no layout adopted", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();

    // Teardown supersedes the in-flight pass. The queue serialises runs, so
    // this is the reachable half of the staleness guard; the request id is the
    // second line of defence for the same rule.
    h.orchestrator.destroy();
    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    assert.equal(h.orchestrator.lastLayout, null);
    assert.deepEqual(h.published, [], "stale counts must not be published");
    assert.deepEqual(h.events, [
      "adopt(g1)",
      "run:full(g1,vis=a|b|c,kinds=Import,amb=false)",
    ]);
  });

  it("discards a superseded edge phase without overwriting the newer layout", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    const applied = layoutNamed("L1");
    h.fullGates[0]!.resolve(applied);
    await flush();

    h.orchestrator.requestEdgePhase(new Set<EdgeKind>(["Import"]), false);
    await flush();
    h.orchestrator.destroy();
    h.edgeGates[0]!.resolve(layoutNamed("L2"));
    await flush();

    assert.equal(h.orchestrator.lastLayout, applied, "L2 was stale -- discarded");
    assert.deepEqual(h.published, ["L1"]);
    assert.deepEqual(h.appliedEdgeRequests, []);
  });

  it("drops the queued rerun on teardown", async () => {
    const h = harness();

    requestFull(h, "g1", ALL_NODES);
    await flush();
    requestFull(h, "g2", ALL_NODES);
    h.orchestrator.destroy();
    h.fullGates[0]!.resolve(layoutNamed("L1"));
    await flush();

    assert.deepEqual(h.fullRequests.map((r) => r.graph.root), ["g1"]);
  });

  it("runs nothing while the consumer is not ready", async () => {
    const h = harness();
    h.setReady(false);

    requestFull(h, "g1", ALL_NODES);
    await flush();

    assert.deepEqual(h.events, []);
    assert.equal(h.orchestrator.lastLayout, null);
  });
});
