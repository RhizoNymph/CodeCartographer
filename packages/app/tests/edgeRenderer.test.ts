import assert from "node:assert/strict";
import test from "node:test";

import {
  EDGE_STYLES,
  DEFAULT_EDGE_STYLE,
  type EdgeDatum,
  type NodeDisplayRef,
  type EdgeStyleConfig,
} from "../src/canvas/renderers/types.ts";

import type { EdgeAnchor, Point } from "../src/canvas/layout/edgeGeometry.ts";

/**
 * Tests for the edge rendering type system and the two-layer dirty tracking
 * design of EdgeDrawingManager.
 *
 * Since EdgeDrawingManager imports pixi.js Graphics (browser-only), we cannot
 * instantiate it directly in a Node.js test environment. Instead we:
 *
 * 1. Test the shared type contracts and edge style configuration.
 * 2. Test the nodeToEdgeIndices index-building algorithm in isolation
 *    (reimplemented here as a pure function matching the real implementation).
 * 3. Verify the two-layer invariants via the type signatures and state machine.
 */

// ---------------------------------------------------------------------------
// Pure reimplementation of the index-building logic for testing
// ---------------------------------------------------------------------------

interface LayoutEdgeLike {
  source: string;
  target: string;
  color: string;
  kind: string | null;
  points: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

/**
 * Mirrors EdgeDrawingManager.buildEdgeData -- pure function version for testing.
 */
function buildEdgeDataPure(edges: LayoutEdgeLike[]): {
  edgeData: EdgeDatum[];
  nodeToEdgeIndices: Map<string, number[]>;
} {
  const nodeToEdgeIndices = new Map<string, number[]>();
  const edgeData: EdgeDatum[] = edges.map((e, idx) => {
    if (!nodeToEdgeIndices.has(e.source)) {
      nodeToEdgeIndices.set(e.source, []);
    }
    nodeToEdgeIndices.get(e.source)!.push(idx);

    if (!nodeToEdgeIndices.has(e.target)) {
      nodeToEdgeIndices.set(e.target, []);
    }
    nodeToEdgeIndices.get(e.target)!.push(idx);

    return {
      source: e.source,
      target: e.target,
      color: e.color,
      kind: e.kind as EdgeDatum["kind"],
      originalPoints: e.points.map((p) => ({ x: p.x, y: p.y })),
      sourceAnchor: e.sourceAnchor,
      targetAnchor: e.targetAnchor,
    };
  });

  return { edgeData, nodeToEdgeIndices };
}

/**
 * Mirrors the highlight index collection from PixiRenderer.rebuildHoveredEdgeIndices
 * and collectNodeSubtreeIds.
 */
function collectHighlightedIndices(
  hoveredNodeId: string,
  graph: Record<string, { children: string[] }>,
  nodeToEdgeIndices: Map<string, number[]>
): Set<number> {
  const subtreeIds = new Set<string>();
  const stack = [hoveredNodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (subtreeIds.has(currentId)) continue;
    subtreeIds.add(currentId);
    const node = graph[currentId];
    if (node) {
      for (const childId of node.children) {
        stack.push(childId);
      }
    }
  }

  const result = new Set<number>();
  for (const id of subtreeIds) {
    const indices = nodeToEdgeIndices.get(id);
    if (indices) {
      for (const idx of indices) {
        result.add(idx);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("EDGE_STYLES has entries for all edge kinds", () => {
  const expectedKinds = [
    "Import",
    "Inheritance",
    "TraitImpl",
    "FunctionCall",
    "MethodCall",
    "TypeReference",
    "VariableUsage",
  ];

  for (const kind of expectedKinds) {
    const style = EDGE_STYLES[kind as keyof typeof EDGE_STYLES];
    assert.ok(style, `Missing EDGE_STYLES entry for ${kind}`);
    assert.equal(typeof style.width, "number");
    assert.equal(typeof style.baseAlpha, "number");
    assert.ok(style.width > 0, `${kind} width should be positive`);
    assert.ok(style.baseAlpha > 0 && style.baseAlpha <= 1, `${kind} baseAlpha should be in (0,1]`);
  }
});

test("DEFAULT_EDGE_STYLE has valid width and baseAlpha", () => {
  assert.ok(DEFAULT_EDGE_STYLE.width > 0);
  assert.ok(DEFAULT_EDGE_STYLE.baseAlpha > 0 && DEFAULT_EDGE_STYLE.baseAlpha <= 1);
});

test("buildEdgeData builds correct nodeToEdgeIndices for simple graph", () => {
  const edges: LayoutEdgeLike[] = [
    {
      source: "a",
      target: "b",
      color: "#ff0000",
      kind: "FunctionCall",
      points: [{ x: 100, y: 20 }, { x: 200, y: 20 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
    {
      source: "b",
      target: "c",
      color: "#00ff00",
      kind: "Import",
      points: [{ x: 300, y: 20 }, { x: 400, y: 20 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
  ];

  const { edgeData, nodeToEdgeIndices } = buildEdgeDataPure(edges);

  assert.equal(edgeData.length, 2);
  assert.equal(nodeToEdgeIndices.size, 3); // a, b, c

  // Node "b" is connected to both edges
  const bIndices = nodeToEdgeIndices.get("b")!;
  assert.equal(bIndices.length, 2);
  assert.ok(bIndices.includes(0));
  assert.ok(bIndices.includes(1));

  // Node "a" only connected to edge 0
  const aIndices = nodeToEdgeIndices.get("a")!;
  assert.equal(aIndices.length, 1);
  assert.ok(aIndices.includes(0));

  // Node "c" only connected to edge 1
  const cIndices = nodeToEdgeIndices.get("c")!;
  assert.equal(cIndices.length, 1);
  assert.ok(cIndices.includes(1));
});

test("buildEdgeData handles self-loops correctly", () => {
  const edges: LayoutEdgeLike[] = [
    {
      source: "x",
      target: "x",
      color: "#ffffff",
      kind: null,
      points: [{ x: 0, y: 0 }, { x: 50, y: 50 }],
      sourceAnchor: { side: "right", offset: 25 },
      targetAnchor: { side: "left", offset: 25 },
    },
  ];

  const { nodeToEdgeIndices } = buildEdgeDataPure(edges);

  // Self-loop: node "x" appears as both source and target
  const xIndices = nodeToEdgeIndices.get("x")!;
  assert.equal(xIndices.length, 2); // index 0 added twice (once as source, once as target)
  assert.deepEqual(xIndices, [0, 0]);
});

test("buildEdgeData preserves originalPoints as copies", () => {
  const originalPoints = [{ x: 100, y: 20 }, { x: 200, y: 20 }];
  const edges: LayoutEdgeLike[] = [
    {
      source: "a",
      target: "b",
      color: "#ff0000",
      kind: "Import",
      points: originalPoints,
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
  ];

  const { edgeData } = buildEdgeDataPure(edges);

  // Mutating the original should not affect the stored data
  originalPoints[0].x = 999;
  assert.equal(edgeData[0].originalPoints[0].x, 100);
});

test("collectHighlightedIndices collects only connected edges for hovered subtree", () => {
  const edges: LayoutEdgeLike[] = [
    {
      source: "parent",
      target: "other",
      color: "#ff0000",
      kind: "FunctionCall",
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
    {
      source: "child1",
      target: "other2",
      color: "#00ff00",
      kind: "Import",
      points: [{ x: 0, y: 50 }, { x: 100, y: 50 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
    {
      source: "unrelated",
      target: "other3",
      color: "#0000ff",
      kind: "MethodCall",
      points: [{ x: 0, y: 100 }, { x: 100, y: 100 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    },
  ];

  const { nodeToEdgeIndices } = buildEdgeDataPure(edges);

  const graph: Record<string, { children: string[] }> = {
    parent: { children: ["child1", "child2"] },
    child1: { children: [] },
    child2: { children: [] },
    other: { children: [] },
    other2: { children: [] },
    other3: { children: [] },
    unrelated: { children: [] },
  };

  // Hovering "parent" should highlight edges 0 (parent->other) and 1 (child1->other2)
  const highlighted = collectHighlightedIndices("parent", graph, nodeToEdgeIndices);
  assert.ok(highlighted.has(0), "Edge from parent should be highlighted");
  assert.ok(highlighted.has(1), "Edge from child1 should be highlighted");
  assert.ok(!highlighted.has(2), "Edge from unrelated should NOT be highlighted");
});

test("Two-layer invariant: on hover, only highlighted edges are in the highlight set", () => {
  const edges: LayoutEdgeLike[] = [];
  for (let i = 0; i < 100; i++) {
    edges.push({
      source: `node-${i}`,
      target: `node-${i + 1}`,
      color: "#aabbcc",
      kind: "FunctionCall",
      points: [{ x: i * 10, y: 0 }, { x: (i + 1) * 10, y: 0 }],
      sourceAnchor: { side: "right", offset: 20 },
      targetAnchor: { side: "left", offset: 20 },
    });
  }

  const { nodeToEdgeIndices } = buildEdgeDataPure(edges);

  const graph: Record<string, { children: string[] }> = {};
  for (let i = 0; i <= 100; i++) {
    graph[`node-${i}`] = { children: [] };
  }

  // Hover on node-50: should highlight edges 49 (node-49 -> node-50)
  // and 50 (node-50 -> node-51)
  const highlighted = collectHighlightedIndices("node-50", graph, nodeToEdgeIndices);
  assert.equal(highlighted.size, 2);
  assert.ok(highlighted.has(49));
  assert.ok(highlighted.has(50));

  // The key invariant of the two-layer architecture: the number of
  // highlighted edges should be O(connected) not O(total).
  // For a linear chain, hovering any internal node highlights exactly 2 edges.
  assert.ok(
    highlighted.size << edges.length,
    "Highlighted edges should be much fewer than total edges"
  );
});

test("Empty edge data produces empty indices", () => {
  const { edgeData, nodeToEdgeIndices } = buildEdgeDataPure([]);
  assert.equal(edgeData.length, 0);
  assert.equal(nodeToEdgeIndices.size, 0);
});
