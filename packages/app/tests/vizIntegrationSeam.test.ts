import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LayoutOrchestrator,
  type LayoutOrchestratorEffects,
} from "../src/canvas/layout/layoutOrchestrator.ts";
import type {
  LayoutNodePosition,
  LayoutResult,
} from "../src/canvas/layout/layoutTypes.ts";
import type { ViewEdge } from "../src/canvas/layout/viewEdges.ts";
import { rebuildEdges } from "../src/canvas/layout/edgeRebuild.ts";
import { straightLineEdge } from "../src/canvas/layout/straightEdges.ts";
import {
  routeEdges,
  type EdgeRouteInput,
} from "../src/canvas/layout/edgeRoutePipeline.ts";
import { getAnchorPoint } from "../src/canvas/layout/edgeGeometry.ts";
import { unknownEdgeKindCounts } from "../src/canvas/legend/edgeLegendModel.ts";
import type { CodeGraph, EdgeKind } from "../src/api/types.ts";

// Integration seam test between the layout ORCHESTRATOR (which decides which
// phase runs against which previous result) and the edge GEOMETRY chain (which
// decides what those results contain). Each side is unit-tested with fakes on
// its own; this file wires the real geometry functions in as the orchestrator's
// effects and pins the composed behavior:
//
//   1. The edges phase always receives the NEWEST applied layout as `previous`
//      -- including a previous EDGE phase's result, not just the last full
//      layout. If the orchestrator failed to adopt an edge-phase result as
//      lastLayout, the second rerun below would rebuild from stale input and
//      the identity assertions would fail.
//   2. Routed polylines survive edge-phase reruns through that adoption
//      (rebuildEdges cache-reuses by source/target/kind against `previous`).
//   3. Everything the chain emits still satisfies the anchor contract after
//      the full draw-time pipeline: >= 2 points, endpoints sitting exactly on
//      getAnchorPoint(box, anchor) -- even for endpoints that lane spreading
//      moved (whose anchors must move WITH them).

/** Let the orchestrator's queued microtasks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const nodes: Record<string, LayoutNodePosition> = {
  a: { x: 0, y: 0, width: 100, height: 40 },
  b: { x: 300, y: 0, width: 100, height: 40 },
  c: { x: 0, y: 200, width: 100, height: 40 },
};

// Both edges land on b's LEFT side, so lane spreading has a group to fan out.
const AB: ViewEdge = {
  source: "a",
  target: "b",
  color: "#ef4444",
  kind: "FunctionCall",
  count: 1,
  resolution: "Direct",
};
const CB: ViewEdge = {
  source: "c",
  target: "b",
  color: "#3b82f6",
  kind: "Import",
  count: 1,
  resolution: "Direct",
};

function viewEdgesFor(kinds: Set<EdgeKind>): ViewEdge[] {
  return [AB, CB].filter((edge) => edge.kind !== null && kinds.has(edge.kind));
}

const graph = { nodes: {}, root: "a", edgeCount: 2 } as unknown as CodeGraph;

const FUNCTION_CALL_ONLY = new Set<EdgeKind>(["FunctionCall"]);
const BOTH_KINDS = new Set<EdgeKind>(["FunctionCall", "Import"]);

interface Harness {
  orchestrator: LayoutOrchestrator;
  fullLayout: LayoutResult;
  /** The `previous` argument each edge-phase run received, in order. */
  edgePhasePrevious: LayoutResult[];
  /** Each edge-phase result the orchestrator APPLIED, in order. */
  appliedEdgeLayouts: LayoutResult[];
  errors: unknown[];
}

/** An orchestrator whose effects run the REAL edge-geometry chain. */
function makeHarness(): Harness {
  // The full layout carries only the FunctionCall edge, straight-lined by the
  // real layout-time anchor decision.
  const abEdge = straightLineEdge(nodes, AB);
  assert.ok(abEdge, "fixture: straightLineEdge must produce the a->b edge");
  const fullLayout: LayoutResult = {
    nodes,
    edges: [abEdge],
    edgeKindCounts: unknownEdgeKindCounts(),
    renderIds: ["a", "b", "c"],
  };

  const edgePhasePrevious: LayoutResult[] = [];
  const appliedEdgeLayouts: LayoutResult[] = [];
  const errors: unknown[] = [];

  const effects: LayoutOrchestratorEffects = {
    waitUntilReady: async () => true,
    runFullLayout: async () => fullLayout,
    runEdgePhase: async (previous, enabledEdgeKinds) => {
      edgePhasePrevious.push(previous);
      return {
        nodes: previous.nodes,
        edges: rebuildEdges(previous, viewEdgesFor(enabledEdgeKinds)),
        edgeKindCounts: unknownEdgeKindCounts(),
        renderIds: previous.renderIds,
      };
    },
    adoptFullLayoutInputs: () => {},
    applyFullLayout: () => {},
    applyEdgeLayout: (layout) => {
      appliedEdgeLayouts.push(layout);
    },
    applyVisibleNodes: () => {},
    redrawEdges: () => {},
    publishEdgeKindCounts: () => {},
    reportError: (error) => {
      errors.push(error);
    },
  };

  return {
    orchestrator: new LayoutOrchestrator(effects),
    fullLayout,
    edgePhasePrevious,
    appliedEdgeLayouts,
    errors,
  };
}

/** Feed a rebuilt layout's edges to the draw-time pipeline, undragged. */
function routeLayoutEdges(layout: LayoutResult) {
  const inputs: EdgeRouteInput[] = layout.edges.map((edge, index) => ({
    index,
    sourceId: edge.source,
    targetId: edge.target,
    layoutPoints: edge.points,
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    sourceBox: layout.nodes[edge.source],
    targetBox: layout.nodes[edge.target],
    sourceDelta: { x: 0, y: 0 },
    targetDelta: { x: 0, y: 0 },
  }));

  return routeEdges(inputs, {
    visibleNodeCount: Object.keys(layout.nodes).length,
    edgesVisible: true,
    obstacles: () => null,
  });
}

function assertPointsNearlyEqual(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  label: string
): void {
  const tolerance = 0.5; // normalizeRoutedPolyline's point-merge tolerance
  assert.ok(
    Math.abs(actual.x - expected.x) <= tolerance &&
      Math.abs(actual.y - expected.y) <= tolerance,
    `${label}: (${actual.x}, ${actual.y}) != (${expected.x}, ${expected.y})`
  );
}

describe("orchestrator x edge-geometry seam", () => {
  it("feeds each edge phase the newest applied layout and reuses routes through it", async () => {
    const h = makeHarness();

    h.orchestrator.requestFullLayout(
      graph,
      new Set(),
      new Set(["a", "b", "c"]),
      FUNCTION_CALL_ONLY,
      false
    );
    await flush();
    assert.equal(h.orchestrator.lastLayout, h.fullLayout);

    // Edge phase 1: Import toggled on. Must rebuild against the FULL layout.
    h.orchestrator.requestEdgePhase(BOTH_KINDS, false);
    await flush();
    assert.equal(h.edgePhasePrevious.length, 1);
    assert.equal(h.edgePhasePrevious[0], h.fullLayout);
    const phase1 = h.appliedEdgeLayouts[0];
    assert.ok(phase1, "edge phase 1 must be applied");

    const phase1Ab = phase1.edges.find((e) => e.source === "a");
    const phase1Cb = phase1.edges.find((e) => e.source === "c");
    assert.ok(phase1Ab && phase1Cb, "phase 1 must carry both edges");
    // The surviving edge kept its routed polyline; the new one was built fresh
    // (straight-line fallback, orthogonalized -- a diagonal gains bends).
    assert.deepEqual(phase1Ab.points, h.fullLayout.edges[0].points);
    assert.ok(phase1Cb.points.length >= 2);

    // Edge phase 2, same kinds. Must rebuild against PHASE 1's result -- this
    // is the adoption seam: the orchestrator has to have taken the edge-phase
    // result as its lastLayout, or reuse breaks silently.
    h.orchestrator.requestEdgePhase(BOTH_KINDS, false);
    await flush();
    assert.equal(h.edgePhasePrevious.length, 2);
    assert.equal(h.edgePhasePrevious[1], phase1);

    const phase2 = h.appliedEdgeLayouts[1];
    assert.ok(phase2, "edge phase 2 must be applied");
    const phase2Ab = phase2.edges.find((e) => e.source === "a");
    const phase2Cb = phase2.edges.find((e) => e.source === "c");
    assert.ok(phase2Ab && phase2Cb, "phase 2 must carry both edges");
    // Both edges now cache-hit against phase 1's geometry.
    assert.deepEqual(phase2Ab.points, phase1Ab.points);
    assert.deepEqual(phase2Cb.points, phase1Cb.points);

    assert.deepEqual(h.errors, []);
  });

  it("keeps anchors and geometry in agreement through the draw-time pipeline", async () => {
    const h = makeHarness();

    h.orchestrator.requestFullLayout(
      graph,
      new Set(),
      new Set(["a", "b", "c"]),
      FUNCTION_CALL_ONLY,
      false
    );
    await flush();
    h.orchestrator.requestEdgePhase(BOTH_KINDS, false);
    await flush();

    const phase1 = h.appliedEdgeLayouts[0];
    assert.ok(phase1);
    const { edges: routed } = routeLayoutEdges(phase1);
    assert.equal(routed.length, 2);

    for (const edge of routed) {
      // The drawing pass's contract: drawable, endpoints ON the boxes...
      assert.ok(edge.points.length >= 2);
      // ...and the emitted anchors describe the emitted geometry exactly,
      // including endpoints that lane spreading moved.
      assertPointsNearlyEqual(
        edge.points[0],
        getAnchorPoint(edge.sourceBox, edge.sourceAnchor),
        `${edge.sourceId}->${edge.targetId} source`
      );
      assertPointsNearlyEqual(
        edge.points[edge.points.length - 1],
        getAnchorPoint(edge.targetBox, edge.targetAnchor),
        `${edge.sourceId}->${edge.targetId} target`
      );
    }

    // Both edges land on b's left side, so lane spreading MUST have separated
    // their offsets (and moved their anchors with them).
    const [abRouted, cbRouted] = [
      routed.find((e) => e.sourceId === "a"),
      routed.find((e) => e.sourceId === "c"),
    ];
    assert.ok(abRouted && cbRouted);
    assert.equal(abRouted.targetAnchor.side, "left");
    assert.equal(cbRouted.targetAnchor.side, "left");
    assert.notEqual(abRouted.targetAnchor.offset, cbRouted.targetAnchor.offset);
  });
});
