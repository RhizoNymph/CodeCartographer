import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rebuildEdges } from "../src/canvas/layout/edgeRebuild.ts";
import type {
  LayoutEdge,
  LayoutNodePosition,
  LayoutResult,
} from "../src/canvas/layout/layoutTypes.ts";
import type { ViewEdge } from "../src/canvas/layout/viewEdges.ts";

// Seam test between the edge-only layout phase and the edge drawing pass:
// the phase rebuilds edges on cached positions (reusing routed polylines,
// straight-lining new arrivals), and the drawing pass assumes every edge it is
// handed has >= 2 points with endpoints anchored ON the source/target boxes.
// This pins that contract from both sides.

const nodes: Record<string, LayoutNodePosition> = {
  a: { x: 0, y: 0, width: 100, height: 40 },
  b: { x: 300, y: 0, width: 100, height: 40 },
  c: { x: 0, y: 200, width: 100, height: 40 },
};

function routedEdge(overrides: Partial<LayoutEdge> = {}): LayoutEdge {
  return {
    source: "a",
    target: "b",
    color: "#ff0000",
    kind: "FunctionCall",
    count: 1,
    resolution: "Direct",
    // A deliberately bent (ELK-like orthogonal) route that a straight-line
    // rebuild could never reproduce, anchored on both boxes.
    points: [
      { x: 100, y: 20 },
      { x: 200, y: 20 },
      { x: 200, y: 30 },
      { x: 300, y: 30 },
    ],
    sourceAnchor: "right",
    targetAnchor: "left",
    ...overrides,
  } as LayoutEdge;
}

function previousLayout(edges: LayoutEdge[]): LayoutResult {
  return {
    nodes,
    edges,
    edgeKindCounts: {} as LayoutResult["edgeKindCounts"],
    renderIds: Object.keys(nodes),
  };
}

function viewEdge(overrides: Partial<ViewEdge> = {}): ViewEdge {
  return {
    source: "a",
    target: "b",
    color: "#ff0000",
    kind: "FunctionCall",
    count: 1,
    resolution: "Direct",
    ...overrides,
  } as ViewEdge;
}

/** The drawing pass's precondition on any edge it receives. */
function assertDrawable(edge: LayoutEdge) {
  assert.ok(edge.points.length >= 2, "edge must have at least 2 points");

  const src = nodes[edge.source];
  const tgt = nodes[edge.target];
  const first = edge.points[0];
  const last = edge.points[edge.points.length - 1];

  const onBoundary = (p: { x: number; y: number }, box: LayoutNodePosition) => {
    const withinX = p.x >= box.x && p.x <= box.x + box.width;
    const withinY = p.y >= box.y && p.y <= box.y + box.height;
    const onEdgeX = p.x === box.x || p.x === box.x + box.width;
    const onEdgeY = p.y === box.y || p.y === box.y + box.height;
    return withinX && withinY && (onEdgeX || onEdgeY);
  };

  assert.ok(onBoundary(first, src), "first point must sit on the source box");
  assert.ok(onBoundary(last, tgt), "last point must sit on the target box");
}

describe("rebuildEdges (edge phase <-> drawing seam)", () => {
  it("reuses the cached routed polyline for a surviving edge", () => {
    const cached = routedEdge();
    const result = rebuildEdges(previousLayout([cached]), [
      viewEdge({ count: 3, resolution: null }),
    ]);

    assert.equal(result.length, 1);
    // ELK's bent route survives untouched...
    assert.deepEqual(result[0].points, cached.points);
    // ...while the fresh fetch's aggregation facts win.
    assert.equal(result[0].count, 3);
    assert.equal(result[0].resolution, null);
  });

  it("does not reuse a route across a different edge kind", () => {
    const cached = routedEdge({ kind: "FunctionCall" });
    const result = rebuildEdges(previousLayout([cached]), [
      viewEdge({ kind: "TypeReference" }),
    ]);

    assert.equal(result.length, 1);
    // Straight connector, not the cached bent route.
    assert.notDeepEqual(result[0].points, cached.points);
    assert.equal(result[0].kind, "TypeReference");
    assertDrawable(result[0]);
  });

  it("gives parallel same-pair edges their own cached routes, in order", () => {
    const first = routedEdge();
    const second = routedEdge({
      points: [
        { x: 100, y: 30 },
        { x: 300, y: 30 },
      ],
    });
    const result = rebuildEdges(previousLayout([first, second]), [
      viewEdge(),
      viewEdge(),
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0].points, first.points);
    assert.deepEqual(result[1].points, second.points);
  });

  it("straight-lines a newly appearing edge and still satisfies the drawing contract", () => {
    const result = rebuildEdges(previousLayout([]), [
      viewEdge({ source: "a", target: "c", kind: "Import" }),
    ]);

    assert.equal(result.length, 1);
    assertDrawable(result[0]);
  });

  it("drops an edge whose endpoint has no cached position", () => {
    const result = rebuildEdges(previousLayout([]), [
      viewEdge({ source: "a", target: "missing" }),
    ]);

    assert.equal(result.length, 0);
  });

  it("never invents positions: rebuilt edges reference only laid-out nodes", () => {
    const result = rebuildEdges(previousLayout([routedEdge()]), [
      viewEdge(),
      viewEdge({ source: "b", target: "c", kind: "Import" }),
      viewEdge({ source: "missing", target: "b" }),
    ]);

    for (const edge of result) {
      assert.ok(nodes[edge.source], `source ${edge.source} was laid out`);
      assert.ok(nodes[edge.target], `target ${edge.target} was laid out`);
      assertDrawable(edge);
    }
    assert.equal(result.length, 2);
  });
});
