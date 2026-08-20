/**
 * The draw-time edge route pipeline: the single owner of an edge's geometry
 * between "the layout produced this polyline" and "the renderer strokes this
 * polyline".
 *
 * Three stages run in a fixed, visible order (see `routeEdges`):
 *
 *   anchorEndpoints -> spreadEndpointLanes -> detourAroundObstacles
 *
 * Each stage is a pure `(edges, ctx) -> edges` function that returns NEW edge
 * records; nothing is mutated across a stage boundary, so a stage's output is
 * exactly what the next stage saw as input.
 *
 * ## The anchor contract
 *
 * Every edge carries the anchors decided once at layout time
 * (`edgeAnchorAtBoundary`). Stages CONSUME those anchors and derive endpoints
 * from `(box, anchor)` via `getAnchorPoint`; no stage re-reads a polyline to
 * work out which side of a node it came from. A stage that deliberately moves
 * an endpoint (lane spreading) emits an UPDATED anchor with it, so anchors and
 * geometry never disagree.
 *
 * The one legitimate place a fresh anchor is DECIDED at draw time is a node
 * dragged away from its laid-out position: the anchor the layout chose is about
 * geometry that no longer exists, so `anchorEndpoints` picks a new one facing
 * the opposite endpoint. That is a new decision, not a re-derivation.
 *
 * ## Seam contract
 *
 * Every edge this module emits has at least 2 points, with the first on the
 * source box and the last on the target box (see canvas-rendering.md).
 *
 * Runtime imports use explicit `.ts` specifiers so the module chain loads under
 * `node --test`.
 */

import {
  anchorEdgePolyline,
  anchorOnSide,
  ensureDrawablePolyline,
  getAnchorPoint,
  inferEdgeAnchorFromPoint,
  isHorizontalSide,
  normalizeRoutedPolyline,
  rerouteOrthogonalEdge,
  routePolylineAroundObstacles,
  translatePolyline,
  type EdgeAnchor,
  type EdgeAnchorSide,
  type NodeBox,
  type Point,
} from "./edgeGeometry.ts";
import {
  resolveEdgeRoutingMode,
  routesAroundObstacles,
  scoresEdgeCrossings,
  type EdgeRoutingMode,
} from "./edgeRoutingBudget.ts";
import type { ObstacleIndex } from "./obstacleIndex.ts";
import {
  NODE_MOVED_EPSILON,
  OBSTACLE_QUERY_MARGIN,
} from "./routingConstants.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One edge entering the pipeline: its identity, the route and anchors the
 * layout phase decided, and where its endpoint nodes are RIGHT NOW.
 */
export interface EdgeRouteInput {
  /** Index into the renderer's edge data; carried through so results map back. */
  index: number;
  sourceId: string;
  targetId: string;
  /** The polyline the layout phase produced, in layout coordinates. */
  layoutPoints: Point[];
  /** Anchors decided at layout time, against the LAID-OUT boxes. */
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
  /** Current on-screen boxes (post-drag). */
  sourceBox: NodeBox;
  targetBox: NodeBox;
  /** How far each box has moved from where it was laid out. */
  sourceDelta: Point;
  targetDelta: Point;
}

/**
 * How an edge's endpoints came to be where they are. Purely descriptive, but it
 * makes the escalation inside `anchorEdgePolyline` observable instead of silent.
 */
export type EdgeRouteOrigin =
  /** The layout's own route, nudged onto its stored anchors. */
  | "anchored"
  /** The layout's route was unsalvageable; a fresh orthogonal one replaced it. */
  | "rerouted"
  /** Endpoints moved apart, so both anchors were decided anew and re-routed. */
  | "reanchored";

/** An edge after a stage: geometry and anchors always agree. */
export interface RoutedEdge {
  index: number;
  sourceId: string;
  targetId: string;
  points: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
  sourceBox: NodeBox;
  targetBox: NodeBox;
  origin: EdgeRouteOrigin;
}

/** What a redraw offers the pipeline, before the budget gate has spoken. */
export interface EdgeRouteEnv {
  /** Nodes contributing obstacle boxes this redraw; feeds the budget gate. */
  visibleNodeCount: number;
  /** False when the current LOD renders edges fully transparent. */
  edgesVisible: boolean;
  /**
   * The redraw's obstacle boxes, produced ON DEMAND.
   *
   * A thunk because the budget gate can decide there will be no obstacle
   * search at all, and indexing every visible node's boxes for a search that
   * never runs is exactly the waste the gate exists to prevent. Returns null
   * when the caller has no obstacles to offer.
   */
  obstacles: () => ObstacleIndex | null;
}

/** `EdgeRouteEnv` plus the routing mode the budget gate picked. */
export interface EdgeRouteContext extends EdgeRouteEnv {
  mode: EdgeRoutingMode;
}

/** The pipeline's output, with the gate's verdict attached for the caller. */
export interface EdgeRouteResult {
  edges: RoutedEdge[];
  mode: EdgeRoutingMode;
}

/** Shared empty reference list, so the no-scoring path allocates nothing. */
const NO_REFERENCE_POLYLINES: Point[][] = [];

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Run the whole pipeline. The stage order is the body of this function and
 * nowhere else.
 */
export function routeEdges(
  inputs: readonly EdgeRouteInput[],
  env: EdgeRouteEnv
): EdgeRouteResult {
  const anchored = anchorEndpoints(inputs, env);

  // The budget gate reads the number of edges that will actually be stroked,
  // which is only known once stage 1 has dropped the undrawable ones.
  const ctx: EdgeRouteContext = {
    ...env,
    mode: resolveEdgeRoutingMode({
      renderedEdges: anchored.length,
      visibleNodes: env.visibleNodeCount,
      edgesVisible: env.edgesVisible,
    }),
  };

  const spread = spreadEndpointLanes(anchored, ctx);
  const detoured = detourAroundObstacles(spread, ctx);

  return { edges: detoured, mode: ctx.mode };
}

// ---------------------------------------------------------------------------
// Stage 1: anchor endpoints
// ---------------------------------------------------------------------------

/**
 * Put every edge's endpoints on its anchors, against the boxes' CURRENT
 * positions.
 *
 * Three cases, in the order they are cheap:
 *
 * 1. Neither box moved -- the stored anchors still describe the stored route,
 *    so the route only has to be snapped onto them.
 * 2. Both boxes moved by the same delta (a dragged container carrying both
 *    endpoints) -- the route translates with them and the anchors, being box
 *    relative, are untouched.
 * 3. The boxes moved apart -- the stored anchors describe a geometry that no
 *    longer exists, so fresh ones are DECIDED facing the opposite box and the
 *    edge is re-routed from scratch.
 *
 * Edges that cannot produce a drawable polyline are dropped here; the budget
 * gate counts what survives.
 */
export function anchorEndpoints(
  inputs: readonly EdgeRouteInput[],
  _env: EdgeRouteEnv
): RoutedEdge[] {
  const routed: RoutedEdge[] = [];

  for (const input of inputs) {
    const anchored = anchorEdgeRoute(input);
    if (anchored.points.length >= 2) {
      routed.push(anchored);
    }
  }

  return routed;
}

/** Stage 1 for a single edge. See `anchorEndpoints` for the three cases. */
export function anchorEdgeRoute(input: EdgeRouteInput): RoutedEdge {
  const sourceMoved = boxMoved(input.sourceDelta);
  const targetMoved = boxMoved(input.targetDelta);

  if (!sourceMoved && !targetMoved) {
    return anchoredResult(input, input.layoutPoints, input.sourceAnchor, input.targetAnchor);
  }

  if (movedTogether(input.sourceDelta, input.targetDelta)) {
    const translated = translatePolyline(
      input.layoutPoints,
      (input.sourceDelta.x + input.targetDelta.x) / 2,
      (input.sourceDelta.y + input.targetDelta.y) / 2
    );
    // Anchors are offsets INTO a box, so a box that only moved keeps them.
    return anchoredResult(input, translated, input.sourceAnchor, input.targetAnchor);
  }

  const sourceAnchor = inferEdgeAnchorFromPoint(input.sourceBox, boxCenter(input.targetBox));
  const targetAnchor = inferEdgeAnchorFromPoint(input.targetBox, boxCenter(input.sourceBox));

  return {
    index: input.index,
    sourceId: input.sourceId,
    targetId: input.targetId,
    points: rerouteOrthogonalEdge(
      input.layoutPoints,
      input.sourceBox,
      input.targetBox,
      sourceAnchor,
      targetAnchor
    ),
    sourceAnchor,
    targetAnchor,
    sourceBox: input.sourceBox,
    targetBox: input.targetBox,
    origin: "reanchored",
  };
}

function anchoredResult(
  input: EdgeRouteInput,
  points: Point[],
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): RoutedEdge {
  const anchored = anchorEdgePolyline(
    points,
    input.sourceBox,
    input.targetBox,
    sourceAnchor,
    targetAnchor
  );

  return {
    index: input.index,
    sourceId: input.sourceId,
    targetId: input.targetId,
    points: anchored.points,
    sourceAnchor,
    targetAnchor,
    sourceBox: input.sourceBox,
    targetBox: input.targetBox,
    origin: anchored.rerouted ? "rerouted" : "anchored",
  };
}

function boxMoved(delta: Point): boolean {
  return Math.abs(delta.x) > NODE_MOVED_EPSILON || Math.abs(delta.y) > NODE_MOVED_EPSILON;
}

function movedTogether(a: Point, b: Point): boolean {
  return (
    Math.abs(a.x - b.x) <= NODE_MOVED_EPSILON && Math.abs(a.y - b.y) <= NODE_MOVED_EPSILON
  );
}

// ---------------------------------------------------------------------------
// Stage 2: spread endpoint lanes
// ---------------------------------------------------------------------------

/**
 * Fan the edges sharing one side of one node out across that side, so a hub
 * node does not collect a dozen edges on the same point.
 *
 * Grouping reads the STORED anchor side -- the whole point of the anchor
 * contract. Each moved endpoint gets a new offset on the same side, and the
 * edge's anchor is updated to that offset, so the next stage still sees anchors
 * that describe the geometry.
 *
 * Always runs: it is linear in the edge count and independent of the routing
 * budget, which only governs the obstacle search.
 */
export function spreadEndpointLanes(
  edges: readonly RoutedEdge[],
  _ctx: EdgeRouteContext
): RoutedEdge[] {
  // Target ends first, then source ends: a two-point polyline's lane move also
  // nudges the far end's cross-coordinate, and doing the source last leaves the
  // source anchor authoritative -- the order the renderer has always used.
  return spreadOneEnd(spreadOneEnd(edges, true), false);
}

function spreadOneEnd(edges: readonly RoutedEdge[], atEnd: boolean): RoutedEdge[] {
  const groups = new Map<string, RoutedEdge[]>();

  for (const edge of edges) {
    const side = atEnd ? edge.targetAnchor.side : edge.sourceAnchor.side;
    const nodeId = atEnd ? edge.targetId : edge.sourceId;
    const key = `${nodeId}:${side}`;
    const group = groups.get(key);

    if (group) {
      group.push(edge);
    } else {
      groups.set(key, [edge]);
    }
  }

  const moved = new Map<number, RoutedEdge>();

  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }

    const side = atEnd ? group[0].targetAnchor.side : group[0].sourceAnchor.side;

    // Ordered by where the OPPOSITE endpoint sits, so lanes do not cross each
    // other on their way out of the node.
    group.sort((a, b) => {
      const aBox = atEnd ? a.sourceBox : a.targetBox;
      const bBox = atEnd ? b.sourceBox : b.targetBox;
      return orderValueForSide(aBox, side) - orderValueForSide(bBox, side);
    });

    for (let i = 0; i < group.length; i++) {
      const edge = group[i];
      const box = atEnd ? edge.targetBox : edge.sourceBox;
      const anchor: EdgeAnchor = {
        side,
        offset: laneOffset(box, side, i, group.length),
      };
      moved.set(edge.index, moveEndpointToLane(edge, anchor, atEnd));
    }
  }

  if (moved.size === 0) {
    return edges.slice();
  }

  return edges.map((edge) => moved.get(edge.index) ?? edge);
}

/**
 * Move one endpoint onto `anchor` and drag its neighbouring bend across with
 * it, then re-normalise.
 *
 * On a two-point polyline the "neighbouring bend" IS the far endpoint, whose
 * cross-coordinate therefore shifts too; `withOffsetsFromGeometry` re-reads
 * both offsets afterwards so the far anchor stays truthful.
 */
function moveEndpointToLane(
  edge: RoutedEdge,
  anchor: EdgeAnchor,
  atEnd: boolean
): RoutedEdge {
  if (edge.points.length < 2) {
    return edge;
  }

  const box = atEnd ? edge.targetBox : edge.sourceBox;
  const nextPoints = edge.points.map((point) => ({ ...point }));
  const endpoint = getAnchorPoint(box, anchor);
  const endIndex = atEnd ? nextPoints.length - 1 : 0;
  const bendIndex = atEnd ? nextPoints.length - 2 : 1;

  nextPoints[endIndex] = endpoint;
  nextPoints[bendIndex] = isHorizontalSide(anchor.side)
    ? { ...nextPoints[bendIndex], y: endpoint.y }
    : { ...nextPoints[bendIndex], x: endpoint.x };

  const points = ensureDrawablePolyline(normalizeRoutedPolyline(nextPoints), nextPoints);

  return withOffsetsFromGeometry({
    ...edge,
    points,
    sourceAnchor: atEnd ? edge.sourceAnchor : anchor,
    targetAnchor: atEnd ? anchor : edge.targetAnchor,
  });
}

/**
 * Re-read both anchor offsets off the polyline's endpoints, keeping the sides.
 *
 * Only ever called right after this stage moved a point along a side it already
 * owned, so this is a projection of a known-good side, not an inference of
 * which side an edge attached to.
 */
function withOffsetsFromGeometry(edge: RoutedEdge): RoutedEdge {
  const first = edge.points[0];
  const last = edge.points[edge.points.length - 1];

  return {
    ...edge,
    sourceAnchor: anchorOnSide(edge.sourceBox, edge.sourceAnchor.side, first),
    targetAnchor: anchorOnSide(edge.targetBox, edge.targetAnchor.side, last),
  };
}

function sideLength(box: NodeBox, side: EdgeAnchorSide): number {
  return isHorizontalSide(side) ? box.height : box.width;
}

/** Where lane `index` of `count` sits along `side`, inside a small padding. */
export function laneOffset(
  box: NodeBox,
  side: EdgeAnchorSide,
  index: number,
  count: number
): number {
  const length = sideLength(box, side);
  if (count <= 1) {
    return length / 2;
  }

  const padding = Math.min(12, Math.max(4, length / 4));
  const usable = Math.max(1, length - padding * 2);
  return padding + (usable * (index + 1)) / (count + 1);
}

function orderValueForSide(box: NodeBox, side: EdgeAnchorSide): number {
  const center = boxCenter(box);
  return isHorizontalSide(side) ? center.y : center.x;
}

// ---------------------------------------------------------------------------
// Stage 3: detour around obstacles
// ---------------------------------------------------------------------------

/**
 * Push each route clear of the node/label boxes it runs through.
 *
 * The only budget-gated stage: `mode === "none"` returns the routes untouched,
 * and only `"full"` scores candidate detours against the edges routed so far
 * (that scoring is O(E^2) -- see edgeRoutingBudget.ts).
 */
export function detourAroundObstacles(
  edges: readonly RoutedEdge[],
  ctx: EdgeRouteContext
): RoutedEdge[] {
  if (!routesAroundObstacles(ctx.mode)) {
    return edges.slice();
  }

  const index = ctx.obstacles();
  if (!index) {
    return edges.slice();
  }

  const scoreCrossings = scoresEdgeCrossings(ctx.mode);
  const routedPolylines: Point[][] = [];
  const detoured: RoutedEdge[] = [];

  for (const edge of edges) {
    const points = routePolylineAroundObstacles(
      edge.points,
      obstaclesForEdge(index, edge),
      scoreCrossings ? routedPolylines : NO_REFERENCE_POLYLINES
    );
    if (scoreCrossings) {
      routedPolylines.push(points);
    }
    // Detours only bend the middle of a route; the endpoints, and therefore the
    // anchors, are exactly the ones the previous stage settled on.
    detoured.push({ ...edge, points });
  }

  return detoured;
}

/**
 * Obstacles one edge actually has to care about: the boxes near its polyline,
 * minus its own endpoints' boxes and minus any box that swallows an endpoint
 * centre (a collapsed container holding one of the endpoints -- routing around
 * it is impossible, and trying produces long useless detours).
 */
export function obstaclesForEdge(index: ObstacleIndex, edge: RoutedEdge): NodeBox[] {
  const candidates = index.queryForPolyline(
    edge.points,
    OBSTACLE_QUERY_MARGIN,
    edge.sourceId,
    edge.targetId
  );

  if (candidates.length === 0) {
    return candidates;
  }

  const sourceCenter = boxCenter(edge.sourceBox);
  const targetCenter = boxCenter(edge.targetBox);
  const obstacles: NodeBox[] = [];

  for (const box of candidates) {
    if (boxContainsPoint(box, sourceCenter) || boxContainsPoint(box, targetCenter)) {
      continue;
    }
    obstacles.push(box);
  }

  return obstacles;
}

// ---------------------------------------------------------------------------
// Small shared geometry helpers
// ---------------------------------------------------------------------------

export function boxCenter(box: NodeBox): Point {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function boxContainsPoint(box: NodeBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}
