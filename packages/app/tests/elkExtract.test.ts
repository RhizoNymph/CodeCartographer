import assert from "node:assert/strict";
import test from "node:test";

import type { ElkNode } from "elkjs/lib/elk-api";
import {
  extractNodePositions,
  extractRoutedEdges,
} from "../src/canvas/layout/elkExtract.ts";
import { routeEdges } from "../src/canvas/layout/edgeRoutePipeline.ts";
import { getAnchorPoint } from "../src/canvas/layout/edgeGeometry.ts";
import type { ViewEdge } from "../src/canvas/layout/viewEdges";

/**
 * The pure half of ELK extraction, and the anchor round trip it opens: an
 * anchor is decided ONCE here, from pristine geometry, and every later stage
 * consumes it rather than reading it back off a polyline.
 */

const VIEW_EDGES: ViewEdge[] = [
  {
    source: "a",
    target: "b",
    color: "#ff0000",
    kind: "Import",
    count: 3,
    resolution: null,
  },
  {
    source: "a",
    target: "c",
    color: "#00ff00",
    kind: "FunctionCall",
    count: 1,
    resolution: "SameFile",
  },
];

/** Two side-by-side nodes plus one below, with ELK-shaped routed sections. */
function elkTree(): ElkNode {
  return {
    id: "root",
    x: 0,
    y: 0,
    children: [
      { id: "a", x: 0, y: 0, width: 80, height: 40 },
      { id: "b", x: 200, y: 0, width: 80, height: 40 },
      { id: "c", x: 0, y: 200, width: 80, height: 40 },
    ],
    edges: [
      {
        id: "edge-0",
        sources: ["a"],
        targets: ["b"],
        sections: [
          {
            id: "s0",
            startPoint: { x: 80, y: 20 },
            endPoint: { x: 200, y: 20 },
          },
        ],
      },
      {
        id: "edge-1",
        sources: ["a"],
        targets: ["c"],
        sections: [
          {
            id: "s1",
            startPoint: { x: 40, y: 40 },
            bendPoints: [{ x: 40, y: 120 }],
            endPoint: { x: 40, y: 200 },
          },
        ],
      },
    ],
  };
}

test("extractNodePositions accumulates nested container offsets and skips root", () => {
  const nested: ElkNode = {
    id: "root",
    x: 0,
    y: 0,
    children: [
      {
        id: "dir",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        children: [{ id: "file", x: 15, y: 30, width: 80, height: 40 }],
      },
    ],
  };

  const positions = extractNodePositions(nested);

  assert.equal(positions["root"], undefined);
  assert.deepEqual(positions["dir"], { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(positions["file"], { x: 25, y: 50, width: 80, height: 40 });
});

test("extractNodePositions defaults a node ELK left unsized", () => {
  const positions = extractNodePositions({
    id: "root",
    children: [{ id: "bare" }],
  });

  assert.deepEqual(positions["bare"], { x: 0, y: 0, width: 100, height: 40 });
});

test("extraction decides each anchor from the route's own first segment", () => {
  const positions = extractNodePositions(elkTree());
  const { edges, stats } = extractRoutedEdges(elkTree(), positions, VIEW_EDGES);

  assert.equal(stats.totalEdgesFound, 2);
  assert.equal(stats.edgesWithSections, 2);
  assert.equal(stats.edgesWithoutSections, 0);
  assert.equal(edges.length, 2);

  // a -> b leaves a's right edge heading right and enters b's left edge.
  assert.deepEqual(edges[0].sourceAnchor, { side: "right", offset: 20 });
  assert.deepEqual(edges[0].targetAnchor, { side: "left", offset: 20 });

  // a -> c drops out of a's bottom edge and enters c's top edge.
  assert.deepEqual(edges[1].sourceAnchor, { side: "bottom", offset: 40 });
  assert.deepEqual(edges[1].targetAnchor, { side: "top", offset: 40 });
});

test("an extracted edge's endpoints sit exactly on its anchors", () => {
  const positions = extractNodePositions(elkTree());
  const { edges } = extractRoutedEdges(elkTree(), positions, VIEW_EDGES);

  for (const edge of edges) {
    assert.ok(edge.points.length >= 2);
    assert.deepEqual(
      edge.points[0],
      getAnchorPoint(positions[edge.source], edge.sourceAnchor)
    );
    assert.deepEqual(
      edge.points[edge.points.length - 1],
      getAnchorPoint(positions[edge.target], edge.targetAnchor)
    );
  }
});

test("an ELK edge is styled from the view edge its ID encodes, not its endpoints", () => {
  const positions = extractNodePositions(elkTree());
  const { edges } = extractRoutedEdges(elkTree(), positions, VIEW_EDGES);

  assert.equal(edges[0].color, "#ff0000");
  assert.equal(edges[0].kind, "Import");
  assert.equal(edges[0].count, 3);
  assert.equal(edges[1].kind, "FunctionCall");
  assert.equal(edges[1].resolution, "SameFile");
});

test("an ELK edge with no sections falls back to a centre-to-centre connector", () => {
  const tree: ElkNode = {
    id: "root",
    children: [
      { id: "a", x: 0, y: 0, width: 80, height: 40 },
      { id: "b", x: 400, y: 0, width: 80, height: 40 },
    ],
    edges: [{ id: "edge-0", sources: ["a"], targets: ["b"] }],
  };

  const positions = extractNodePositions(tree);
  const { edges, stats } = extractRoutedEdges(tree, positions, VIEW_EDGES);

  assert.equal(stats.edgesWithoutSections, 1);
  assert.equal(edges.length, 1);
  // The centres lie on no side at all, so the anchors come from the dominant
  // axis of the direction the connector heads in.
  assert.deepEqual(edges[0].sourceAnchor, { side: "right", offset: 20 });
  assert.deepEqual(edges[0].targetAnchor, { side: "left", offset: 20 });
});

test("an anchor decided at extract time is what the draw-time pipeline consumes", () => {
  const positions = extractNodePositions(elkTree());
  const { edges } = extractRoutedEdges(elkTree(), positions, VIEW_EDGES);

  // Exactly what EdgeDrawingManager hands the pipeline for an undisturbed view:
  // the layout's points and anchors, against the same boxes.
  const routed = routeEdges(
    edges.map((edge, index) => ({
      index,
      sourceId: edge.source,
      targetId: edge.target,
      layoutPoints: edge.points,
      sourceAnchor: edge.sourceAnchor,
      targetAnchor: edge.targetAnchor,
      sourceBox: positions[edge.source],
      targetBox: positions[edge.target],
      sourceDelta: { x: 0, y: 0 },
      targetDelta: { x: 0, y: 0 },
    })),
    { visibleNodeCount: 3, edgesVisible: true, obstacles: () => null }
  );

  assert.equal(routed.edges.length, edges.length);
  for (const drawn of routed.edges) {
    const layoutEdge = edges[drawn.index];
    assert.equal(drawn.origin, "anchored", "a settled view should need no reroute");
    assert.deepEqual(drawn.sourceAnchor, layoutEdge.sourceAnchor);
    assert.deepEqual(drawn.targetAnchor, layoutEdge.targetAnchor);
    assert.deepEqual(drawn.points, layoutEdge.points);
  }
});
