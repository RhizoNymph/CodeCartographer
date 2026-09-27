import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorEndpoints,
  detourAroundObstacles,
  laneOffset,
  routeEdges,
  spreadEndpointLanes,
  type EdgeRouteContext,
  type EdgeRouteEnv,
  type EdgeRouteInput,
  type RoutedEdge,
} from "../src/canvas/layout/edgeRoutePipeline.ts";
import { resolveEdgeRoutingMode } from "../src/canvas/layout/edgeRoutingBudget.ts";
import {
  getAnchorPoint,
  type EdgeAnchor,
  type NodeBox,
  type Point,
} from "../src/canvas/layout/edgeGeometry.ts";
import {
  ObstacleIndex,
  obstacleEntry,
} from "../src/canvas/layout/obstacleIndex.ts";

/**
 * The draw-time route pipeline: stage order, the anchor contract each stage has
 * to keep, and the budget gate that decides how much of it runs.
 */

// ---------------------------------------------------------------------------
// Fixture: a hub node with two outgoing edges and one obstacle in the way, so
// all three stages have something to do.
// ---------------------------------------------------------------------------

const HUB: NodeBox = { x: 0, y: 0, width: 80, height: 40 };
const RIGHT_NEAR: NodeBox = { x: 400, y: 0, width: 80, height: 40 };
const RIGHT_FAR: NodeBox = { x: 400, y: 120, width: 80, height: 40 };
const BLOCKER: NodeBox = { x: 200, y: 0, width: 80, height: 40 };

const NO_MOVE: Point = { x: 0, y: 0 };

function rightAnchor(offset = 20): EdgeAnchor {
  return { side: "right", offset };
}

function leftAnchor(offset = 20): EdgeAnchor {
  return { side: "left", offset };
}

function hubEdges(): EdgeRouteInput[] {
  return [
    {
      index: 0,
      sourceId: "hub",
      targetId: "near",
      layoutPoints: [
        { x: 80, y: 20 },
        { x: 400, y: 20 },
      ],
      sourceAnchor: rightAnchor(),
      targetAnchor: leftAnchor(),
      sourceBox: HUB,
      targetBox: RIGHT_NEAR,
      sourceDelta: NO_MOVE,
      targetDelta: NO_MOVE,
    },
    {
      index: 1,
      sourceId: "hub",
      targetId: "far",
      layoutPoints: [
        { x: 80, y: 20 },
        { x: 340, y: 20 },
        { x: 340, y: 140 },
        { x: 400, y: 140 },
      ],
      sourceAnchor: rightAnchor(),
      targetAnchor: leftAnchor(),
      sourceBox: HUB,
      targetBox: RIGHT_FAR,
      sourceDelta: NO_MOVE,
      targetDelta: NO_MOVE,
    },
  ];
}

function obstacleEnv(): EdgeRouteEnv {
  return {
    visibleNodeCount: 4,
    edgesVisible: true,
    obstacles: () => new ObstacleIndex([obstacleEntry("blocker", BLOCKER)]),
  };
}

function contextFor(env: EdgeRouteEnv, renderedEdges: number): EdgeRouteContext {
  return {
    ...env,
    mode: resolveEdgeRoutingMode({
      renderedEdges,
      visibleNodes: env.visibleNodeCount,
      edgesVisible: env.edgesVisible,
    }),
  };
}

function endpointsOf(edge: RoutedEdge): { start: Point; end: Point } {
  return {
    start: edge.points[0],
    end: edge.points[edge.points.length - 1],
  };
}

/** Every edge the pipeline emits must satisfy the drawing pass's contract. */
function assertSeamContract(edges: readonly RoutedEdge[]): void {
  for (const edge of edges) {
    assert.ok(edge.points.length >= 2, "every edge must be drawable");
    const { start, end } = endpointsOf(edge);
    assert.deepEqual(
      start,
      getAnchorPoint(edge.sourceBox, edge.sourceAnchor),
      "start point must sit on the source anchor"
    );
    assert.deepEqual(
      end,
      getAnchorPoint(edge.targetBox, edge.targetAnchor),
      "end point must sit on the target anchor"
    );
  }
}

// ---------------------------------------------------------------------------
// Stage order and hand-off
// ---------------------------------------------------------------------------

test("routeEdges is exactly anchor -> spread lanes -> detour, in that order", () => {
  const env = obstacleEnv();
  const inputs = hubEdges();

  const anchored = anchorEndpoints(inputs, env);
  const ctx = contextFor(env, anchored.length);
  const spread = spreadEndpointLanes(anchored, ctx);
  const detoured = detourAroundObstacles(spread, ctx);

  const composed = routeEdges(hubEdges(), obstacleEnv());

  assert.deepEqual(composed.edges, detoured);
  assert.equal(composed.mode, ctx.mode);
});

test("each stage's output is what the next stage sees", () => {
  const env = obstacleEnv();
  const anchored = anchorEndpoints(hubEdges(), env);
  const ctx = contextFor(env, anchored.length);
  const spread = spreadEndpointLanes(anchored, ctx);
  const detoured = detourAroundObstacles(spread, ctx);

  // Stage 1 anchored both edges on the hub's single right-side anchor point...
  assert.deepEqual(anchored[0].points[0], { x: 80, y: 20 });
  assert.deepEqual(anchored[1].points[0], { x: 80, y: 20 });

  // ...stage 2 moved them apart, so it acted on stage 1's geometry...
  assert.notDeepEqual(spread[0].points[0], anchored[0].points[0]);
  assert.notDeepEqual(spread[1].points[0], anchored[1].points[0]);

  // ...and stage 3 detoured the lane-spread route, not the anchored one: the
  // start point it kept is the one stage 2 produced.
  assert.deepEqual(detoured[0].points[0], spread[0].points[0]);
  assert.ok(
    detoured[0].points.length > spread[0].points.length,
    "the blocker should have forced extra bends"
  );
});

test("stages return new records instead of mutating their input", () => {
  const inputs = hubEdges();
  const layoutPointsBefore = inputs.map((input) =>
    input.layoutPoints.map((p) => ({ ...p }))
  );
  const anchorsBefore = inputs.map((input) => ({
    source: { ...input.sourceAnchor },
    target: { ...input.targetAnchor },
  }));

  const env = obstacleEnv();
  const anchored = anchorEndpoints(inputs, env);
  const ctx = contextFor(env, anchored.length);
  const anchoredSnapshot = anchored.map((edge) => ({
    points: edge.points.map((p) => ({ ...p })),
    sourceAnchor: { ...edge.sourceAnchor },
  }));

  const spread = spreadEndpointLanes(anchored, ctx);
  detourAroundObstacles(spread, ctx);

  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(inputs[i].layoutPoints, layoutPointsBefore[i]);
    assert.deepEqual(inputs[i].sourceAnchor, anchorsBefore[i].source);
    assert.deepEqual(inputs[i].targetAnchor, anchorsBefore[i].target);
    assert.deepEqual(anchored[i].points, anchoredSnapshot[i].points);
    assert.deepEqual(anchored[i].sourceAnchor, anchoredSnapshot[i].sourceAnchor);
  }
});

// ---------------------------------------------------------------------------
// The anchor contract
// ---------------------------------------------------------------------------

test("stored anchors survive a redraw of unmoved nodes untouched", () => {
  const [edge] = hubEdges();
  const routed = routeEdges([edge], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  const single = routed.edges[0];
  assert.equal(single.origin, "anchored");
  // No stage re-derived them from the polyline: they are the same anchors the
  // layout phase decided, carried through byte for byte.
  assert.deepEqual(single.sourceAnchor, edge.sourceAnchor);
  assert.deepEqual(single.targetAnchor, edge.targetAnchor);
  assertSeamContract(routed.edges);
});

test("lane spreading moves an endpoint AND its anchor together", () => {
  const routed = routeEdges(hubEdges(), {
    visibleNodeCount: 3,
    edgesVisible: true,
    obstacles: () => null,
  });

  const near = routed.edges.find((edge) => edge.index === 0)!;
  const far = routed.edges.find((edge) => edge.index === 1)!;

  // Both still leave the hub's right side, but on their own lanes...
  assert.equal(near.sourceAnchor.side, "right");
  assert.equal(far.sourceAnchor.side, "right");
  assert.notEqual(near.sourceAnchor.offset, far.sourceAnchor.offset);

  // ...at exactly the offsets the lane model prescribes, ordered by where the
  // opposite endpoint sits.
  assert.equal(near.sourceAnchor.offset, laneOffset(HUB, "right", 0, 2));
  assert.equal(far.sourceAnchor.offset, laneOffset(HUB, "right", 1, 2));

  // The far ends land on DIFFERENT nodes, so each is a lane of one. `far` has
  // interior bends to absorb the source move and keeps its layout anchor...
  assert.deepEqual(far.targetAnchor, leftAnchor());

  // ...while `near` is a straight two-point run, where moving the source lane
  // necessarily drags the far end's row with it. The anchor FOLLOWS that move
  // rather than going stale, which is the invariant under test.
  assert.equal(near.targetAnchor.side, "left");
  assert.equal(near.targetAnchor.offset, near.sourceAnchor.offset);

  // ...and geometry and anchors still agree, which is the whole contract.
  assertSeamContract(routed.edges);
});

test("nodes dragged apart get freshly DECIDED anchors, not re-derived ones", () => {
  const [edge] = hubEdges();
  // The target has been dragged far below its laid-out position; the anchor the
  // layout picked ("left") describes geometry that no longer exists.
  const dragged: EdgeRouteInput = {
    ...edge,
    targetBox: { x: 20, y: 400, width: 80, height: 40 },
    targetDelta: { x: -380, y: 400 },
  };

  const routed = routeEdges([dragged], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  const result = routed.edges[0];
  assert.equal(result.origin, "reanchored");
  assert.equal(result.sourceAnchor.side, "bottom");
  assert.equal(result.targetAnchor.side, "top");
  assertSeamContract(routed.edges);
});

test("a container drag that moves both endpoints keeps the stored anchors", () => {
  const [edge] = hubEdges();
  const delta = { x: 60, y: 25 };
  const shifted: EdgeRouteInput = {
    ...edge,
    sourceBox: { ...HUB, x: HUB.x + delta.x, y: HUB.y + delta.y },
    targetBox: { ...RIGHT_NEAR, x: RIGHT_NEAR.x + delta.x, y: RIGHT_NEAR.y + delta.y },
    sourceDelta: delta,
    targetDelta: delta,
  };

  const routed = routeEdges([shifted], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  const result = routed.edges[0];
  assert.equal(result.origin, "anchored");
  // Anchors are offsets INTO a box, so a box that only moved keeps them.
  assert.deepEqual(result.sourceAnchor, edge.sourceAnchor);
  assert.deepEqual(result.targetAnchor, edge.targetAnchor);
  assert.deepEqual(result.points[0], { x: 140, y: 45 });
  assertSeamContract(routed.edges);
});

// ---------------------------------------------------------------------------
// The anchored-vs-rerouted decision
// ---------------------------------------------------------------------------

test("an unsalvageable route is reported as rerouted, not silently replaced", () => {
  // The stored route leaves the hub's right side heading LEFT, which its anchor
  // forbids: anchoring cannot nudge this into shape.
  const broken: EdgeRouteInput = {
    index: 0,
    sourceId: "hub",
    targetId: "near",
    layoutPoints: [
      { x: 80, y: 20 },
      { x: -60, y: 20 },
      { x: 400, y: 20 },
    ],
    sourceAnchor: rightAnchor(),
    targetAnchor: { side: "right", offset: 20 },
    sourceBox: HUB,
    targetBox: RIGHT_NEAR,
    sourceDelta: NO_MOVE,
    targetDelta: NO_MOVE,
  };

  const routed = routeEdges([broken], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  assert.equal(routed.edges[0].origin, "rerouted");
  assertSeamContract(routed.edges);
});

test("a salvageable route keeps the layout's geometry and says so", () => {
  const [edge] = hubEdges();
  const routed = routeEdges([edge], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  assert.equal(routed.edges[0].origin, "anchored");
  assert.deepEqual(routed.edges[0].points, edge.layoutPoints);
});

// ---------------------------------------------------------------------------
// The budget gate
// ---------------------------------------------------------------------------

test("the detour stage is the only budget-gated one", () => {
  const env = obstacleEnv();
  const anchored = anchorEndpoints(hubEdges(), env);
  const spread = spreadEndpointLanes(anchored, { ...env, mode: "none" });

  // Lanes are spread regardless of the mode...
  assert.notDeepEqual(spread[0].points[0], anchored[0].points[0]);

  // ...but "none" leaves the geometry exactly where stage 2 left it.
  const skipped = detourAroundObstacles(spread, { ...env, mode: "none" });
  assert.deepEqual(skipped, spread);
});

test("an invisible-edge LOD never pays for the obstacle index", () => {
  let indexBuilds = 0;
  const routed = routeEdges(hubEdges(), {
    visibleNodeCount: 4,
    edgesVisible: false,
    obstacles: () => {
      indexBuilds++;
      return new ObstacleIndex([obstacleEntry("blocker", BLOCKER)]);
    },
  });

  assert.equal(routed.mode, "none");
  assert.equal(indexBuilds, 0, "the gate must decide before the index is built");
});

test("a routed redraw detours around the obstacles it is given", () => {
  const routed = routeEdges(hubEdges(), obstacleEnv());

  assert.equal(routed.mode, "full");
  const near = routed.edges.find((edge) => edge.index === 0)!;
  assert.ok(
    near.points.some(
      (point) => point.y < BLOCKER.y || point.y > BLOCKER.y + BLOCKER.height
    ),
    `expected a detour clear of the blocker: ${JSON.stringify(near.points)}`
  );
  // Detours bend the middle; the endpoints stay on the anchors stage 2 settled.
  assertSeamContract(routed.edges);
});

test("an edge with no drawable layout route is dropped before the gate counts", () => {
  const degenerate: EdgeRouteInput = {
    ...hubEdges()[0],
    index: 7,
    layoutPoints: [{ x: 80, y: 20 }],
  };

  const routed = routeEdges([degenerate], {
    visibleNodeCount: 2,
    edgesVisible: true,
    obstacles: () => null,
  });

  assert.equal(routed.edges.length, 0);
  assert.equal(routed.mode, "none", "no rendered edges means no routing to budget");
});
