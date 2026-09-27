import assert from "node:assert/strict";
import test from "node:test";

import {
  CROSSING_AWARE_EDGE_LIMIT,
  LAYOUT_EDGE_ROUTING_EDGE_LIMIT,
  LAYOUT_EDGE_ROUTING_NODE_LIMIT,
  OBSTACLE_ROUTING_EDGE_LIMIT,
  OBSTACLE_ROUTING_NODE_LIMIT,
  resolveEdgeRoutingMode,
  routesAroundObstacles,
  scoresEdgeCrossings,
  shouldSkipLayoutEdgeRouting,
  type EdgeRoutingMode,
} from "../src/canvas/layout/edgeRoutingBudget.ts";

/** Cheapest first; used to assert the mode never gets MORE expensive as work grows. */
const MODE_COST: Record<EdgeRoutingMode, number> = {
  none: 0,
  obstacles: 1,
  full: 2,
};

test("thresholds are ordered: crossing scoring is dropped before routing is", () => {
  assert.ok(
    CROSSING_AWARE_EDGE_LIMIT <= OBSTACLE_ROUTING_EDGE_LIMIT,
    "crossing-score limit must be the smaller (or equal) threshold"
  );
});

test("small graphs get the full crossing-aware router", () => {
  const mode = resolveEdgeRoutingMode({ renderedEdges: 40, visibleNodes: 60 });
  assert.equal(mode, "full");
  assert.equal(routesAroundObstacles(mode), true);
  assert.equal(scoresEdgeCrossings(mode), true);
});

test("full routing holds right up to the crossing-score limit", () => {
  assert.equal(
    resolveEdgeRoutingMode({
      renderedEdges: CROSSING_AWARE_EDGE_LIMIT,
      visibleNodes: 100,
    }),
    "full"
  );
});

test("past the crossing-score limit, obstacle avoidance stays but scoring is dropped", () => {
  const mode = resolveEdgeRoutingMode({
    renderedEdges: CROSSING_AWARE_EDGE_LIMIT + 1,
    visibleNodes: 100,
  });
  assert.equal(mode, "obstacles");
  assert.equal(routesAroundObstacles(mode), true);
  assert.equal(scoresEdgeCrossings(mode), false);
});

test("obstacle routing holds right up to the routing limit", () => {
  assert.equal(
    resolveEdgeRoutingMode({
      renderedEdges: OBSTACLE_ROUTING_EDGE_LIMIT,
      visibleNodes: 100,
    }),
    "obstacles"
  );
});

test("past the routing limit, edges are drawn as laid out", () => {
  const mode = resolveEdgeRoutingMode({
    renderedEdges: OBSTACLE_ROUTING_EDGE_LIMIT + 1,
    visibleNodes: 100,
  });
  assert.equal(mode, "none");
  assert.equal(routesAroundObstacles(mode), false);
  assert.equal(scoresEdgeCrossings(mode), false);
});

test("too many visible nodes also disables routing, whatever the edge count", () => {
  assert.equal(
    resolveEdgeRoutingMode({
      renderedEdges: 10,
      visibleNodes: OBSTACLE_ROUTING_NODE_LIMIT + 1,
    }),
    "none"
  );
  assert.equal(
    resolveEdgeRoutingMode({
      renderedEdges: 10,
      visibleNodes: OBSTACLE_ROUTING_NODE_LIMIT,
    }),
    "full"
  );
});

test("nothing to draw means nothing to route", () => {
  assert.equal(resolveEdgeRoutingMode({ renderedEdges: 0, visibleNodes: 500 }), "none");
  assert.equal(
    resolveEdgeRoutingMode({ renderedEdges: 20, visibleNodes: 40, edgesVisible: false }),
    "none"
  );
});

test("the 5k node / 20k edge case routes nothing", () => {
  assert.equal(
    resolveEdgeRoutingMode({ renderedEdges: 20000, visibleNodes: 5000 }),
    "none"
  );
});

// ---------------------------------------------------------------------------
// Layout-time (ELK) routing guard
// ---------------------------------------------------------------------------

test("layout routing runs for ordinary views", () => {
  assert.equal(shouldSkipLayoutEdgeRouting(300, 900), false);
  assert.equal(
    shouldSkipLayoutEdgeRouting(
      LAYOUT_EDGE_ROUTING_NODE_LIMIT,
      LAYOUT_EDGE_ROUTING_EDGE_LIMIT
    ),
    false
  );
});

test("layout routing is skipped past the node limit", () => {
  assert.equal(shouldSkipLayoutEdgeRouting(LAYOUT_EDGE_ROUTING_NODE_LIMIT + 1, 10), true);
});

test("layout routing is skipped for edge-heavy views under the node limit", () => {
  // The case the node-only guard missed: few enough nodes, far too many edges.
  assert.equal(shouldSkipLayoutEdgeRouting(1400, 20000), true);
  assert.equal(shouldSkipLayoutEdgeRouting(10, LAYOUT_EDGE_ROUTING_EDGE_LIMIT + 1), true);
});

test("the mode is monotonically non-increasing in both counts", () => {
  // Zero edges is excluded on purpose: "nothing to draw" is its own cheap case,
  // not a point on the budget curve.
  const edgeCounts = [1, 50, 249, 250, 251, 499, 500, 501, 5000, 20000];
  const nodeCounts = [0, 1, 100, 1999, 2000, 2001, 5000];

  for (const nodes of nodeCounts) {
    let previous = Infinity;
    for (const edges of edgeCounts) {
      const cost = MODE_COST[resolveEdgeRoutingMode({ renderedEdges: edges, visibleNodes: nodes })];
      assert.ok(
        cost <= previous,
        `mode became more expensive at edges=${edges}, nodes=${nodes}`
      );
      previous = cost;
    }
  }

  for (const edges of edgeCounts.filter((e) => e > 0)) {
    let previous = Infinity;
    for (const nodes of nodeCounts) {
      const cost = MODE_COST[resolveEdgeRoutingMode({ renderedEdges: edges, visibleNodes: nodes })];
      assert.ok(
        cost <= previous,
        `mode became more expensive at nodes=${nodes}, edges=${edges}`
      );
      previous = cost;
    }
  }
});
