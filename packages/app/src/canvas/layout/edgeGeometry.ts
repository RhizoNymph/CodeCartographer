// Explicit .ts specifier keeps this module (and everything that imports it)
// loadable under `node --test` -- see edgeRebuild.ts and its seam test.
import {
  BOUNDARY_TOLERANCE,
  DETOUR_GUTTER,
  MAX_LEAD_DISTANCE,
  MAX_OBSTACLE_REROUTE_PASSES,
  MIN_LEAD_DISTANCE,
  NODE_OBSTACLE_MARGIN,
  POINT_TOLERANCE,
} from "./routingConstants.ts";

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EdgeAnchorSide = "left" | "right" | "top" | "bottom";

export interface EdgeAnchor {
  side: EdgeAnchorSide;
  offset: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearlyEqual(a: number, b: number, tolerance = POINT_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

function samePoint(a: Point, b: Point): boolean {
  return nearlyEqual(a.x, b.x) && nearlyEqual(a.y, b.y);
}

function withinRange(value: number, min: number, max: number): boolean {
  return value >= min - BOUNDARY_TOLERANCE && value <= max + BOUNDARY_TOLERANCE;
}

function withinPointRange(value: number, min: number, max: number): boolean {
  return value >= min - POINT_TOLERANCE && value <= max + POINT_TOLERANCE;
}

function withinSegmentInterior(value: number, min: number, max: number): boolean {
  return value > min + POINT_TOLERANCE && value < max - POINT_TOLERANCE;
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.max(aMin, bMin) < Math.min(aMax, bMax) - POINT_TOLERANCE;
}

export function isHorizontalSide(side: EdgeAnchorSide): boolean {
  return side === "left" || side === "right";
}

function isVerticalSide(side: EdgeAnchorSide): boolean {
  return side === "top" || side === "bottom";
}

/**
 * An anchor on `side` whose offset is where `point` sits along that side.
 *
 * The offset is a pure projection -- no judgement about whether `point` really
 * belongs to `side`; the caller has already decided that.
 */
export function anchorOnSide(
  nodeBox: NodeBox,
  side: EdgeAnchorSide,
  point: Point
): EdgeAnchor {
  return {
    side,
    offset: isHorizontalSide(side)
      ? clamp(point.y - nodeBox.y, 0, nodeBox.height)
      : clamp(point.x - nodeBox.x, 0, nodeBox.width),
  };
}

/** The box side `point` lies on, or null when it lies on none of them. */
function sideContainingPoint(box: NodeBox, point: Point): EdgeAnchorSide | null {
  const onLeftRightSpan = withinRange(point.y, box.y, box.y + box.height);
  const onTopBottomSpan = withinRange(point.x, box.x, box.x + box.width);

  if (onLeftRightSpan && nearlyEqual(point.x, box.x, BOUNDARY_TOLERANCE)) {
    return "left";
  }
  if (onLeftRightSpan && nearlyEqual(point.x, box.x + box.width, BOUNDARY_TOLERANCE)) {
    return "right";
  }
  if (onTopBottomSpan && nearlyEqual(point.y, box.y, BOUNDARY_TOLERANCE)) {
    return "top";
  }
  if (onTopBottomSpan && nearlyEqual(point.y, box.y + box.height, BOUNDARY_TOLERANCE)) {
    return "bottom";
  }
  return null;
}

/**
 * The anchor an edge endpoint attaches to, decided ONCE at layout time from
 * pristine geometry: the node box, the endpoint the layout put on its boundary,
 * and the point the polyline heads to next.
 *
 * This is an exact reading of the geometry, not a guess about it. An orthogonal
 * edge can only leave a box through the side its FIRST SEGMENT points at, so
 * that direction names the side outright (case 1) -- there is no need to
 * reverse-engineer "which side did the router probably mean" from how close the
 * next bend happens to be to a box edge.
 *
 * Cases 2 and 3 exist for geometry that is not orthogonal at all: the
 * centre-to-centre polyline `extractLayout` synthesises when ELK hands back an
 * edge with no routed sections.
 *
 * Once decided, the anchor is the DURABLE contract carried on `LayoutEdge` and
 * `EdgeDatum`; draw-time stages consume it and never re-derive it from geometry.
 */
export function edgeAnchorAtBoundary(
  nodeBox: NodeBox,
  boundaryPoint: Point,
  adjacentPoint: Point
): EdgeAnchor {
  const dx = adjacentPoint.x - boundaryPoint.x;
  const dy = adjacentPoint.y - boundaryPoint.y;
  const departsVertically = nearlyEqual(dx, 0) && !nearlyEqual(dy, 0);
  const departsHorizontally = nearlyEqual(dy, 0) && !nearlyEqual(dx, 0);

  // 1. Orthogonal departure: the side the segment points through, provided that
  //    side spans the anchor point at all.
  if (
    departsVertically &&
    withinRange(boundaryPoint.x, nodeBox.x, nodeBox.x + nodeBox.width)
  ) {
    return anchorOnSide(nodeBox, dy < 0 ? "top" : "bottom", boundaryPoint);
  }
  if (
    departsHorizontally &&
    withinRange(boundaryPoint.y, nodeBox.y, nodeBox.y + nodeBox.height)
  ) {
    return anchorOnSide(nodeBox, dx < 0 ? "left" : "right", boundaryPoint);
  }

  // 2. Diagonal departure from a point that IS on the boundary: keep the side
  //    it sits on. Such a route fails `polylineRespectsAnchorDirections` and is
  //    rerouted downstream, which is the honest outcome -- relocating the
  //    endpoint to some other side would be the guess this function avoids.
  const sideUnderPoint = sideContainingPoint(nodeBox, boundaryPoint);
  if (sideUnderPoint) {
    return anchorOnSide(nodeBox, sideUnderPoint, boundaryPoint);
  }

  // 3. Not on the boundary at all: the dominant axis of the direction the
  //    polyline heads in.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return anchorOnSide(nodeBox, dx >= 0 ? "right" : "left", boundaryPoint);
  }
  return anchorOnSide(nodeBox, dy >= 0 ? "bottom" : "top", boundaryPoint);
}

export function inferEdgeAnchorFromPoint(
  nodeBox: NodeBox,
  externalPoint: Point
): EdgeAnchor {
  const center = {
    x: nodeBox.x + nodeBox.width / 2,
    y: nodeBox.y + nodeBox.height / 2,
  };
  const dx = externalPoint.x - center.x;
  const dy = externalPoint.y - center.y;
  const halfWidth = Math.max(nodeBox.width / 2, 1);
  const halfHeight = Math.max(nodeBox.height / 2, 1);
  const scaledX = Math.abs(dx) / halfWidth;
  const scaledY = Math.abs(dy) / halfHeight;

  if (scaledY > scaledX) {
    return {
      side: dy >= 0 ? "bottom" : "top",
      offset: clamp(externalPoint.x - nodeBox.x, 0, nodeBox.width),
    };
  }

  return {
    side: dx >= 0 ? "right" : "left",
    offset: clamp(externalPoint.y - nodeBox.y, 0, nodeBox.height),
  };
}

export function getAnchorPoint(nodeBox: NodeBox, anchor: EdgeAnchor): Point {
  const offset =
    anchor.side === "left" || anchor.side === "right"
      ? clamp(anchor.offset, 0, nodeBox.height)
      : clamp(anchor.offset, 0, nodeBox.width);

  switch (anchor.side) {
    case "left":
      return { x: nodeBox.x, y: nodeBox.y + offset };
    case "right":
      return { x: nodeBox.x + nodeBox.width, y: nodeBox.y + offset };
    case "top":
      return { x: nodeBox.x + offset, y: nodeBox.y };
    case "bottom":
      return { x: nodeBox.x + offset, y: nodeBox.y + nodeBox.height };
  }
}

export function dedupePolylinePoints(points: Point[]): Point[] {
  if (points.length <= 1) {
    return points.slice();
  }

  const deduped: Point[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = deduped[deduped.length - 1];
    const current = points[i];
    if (nearlyEqual(prev.x, current.x) && nearlyEqual(prev.y, current.y)) {
      continue;
    }
    deduped.push(current);
  }

  return deduped;
}

export function simplifyOrthogonalPolyline(points: Point[]): Point[] {
  const deduped = dedupePolylinePoints(points);
  if (deduped.length <= 2) {
    return deduped;
  }

  const simplified: Point[] = [deduped[0]];

  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const current = deduped[i];
    const next = deduped[i + 1];

    const collinearX =
      nearlyEqual(prev.x, current.x) &&
      nearlyEqual(current.x, next.x);
    const collinearY =
      nearlyEqual(prev.y, current.y) &&
      nearlyEqual(current.y, next.y);

    if (collinearX || collinearY) {
      continue;
    }

    simplified.push(current);
  }

  simplified.push(deduped[deduped.length - 1]);
  return dedupePolylinePoints(simplified);
}

function isOrthogonalSegment(a: Point, b: Point): boolean {
  return nearlyEqual(a.x, b.x) || nearlyEqual(a.y, b.y);
}

function orthogonalizePolyline(points: Point[]): Point[] {
  const deduped = dedupePolylinePoints(points);
  if (deduped.length <= 1) {
    return deduped;
  }

  const result: Point[] = [deduped[0]];

  for (let i = 1; i < deduped.length; i++) {
    const prev = result[result.length - 1];
    const current = deduped[i];

    if (!isOrthogonalSegment(prev, current)) {
      const prior = result.length >= 2 ? result[result.length - 2] : null;
      const next = i + 1 < deduped.length ? deduped[i + 1] : null;
      const preferVerticalFirst =
        (prior ? nearlyEqual(prior.x, prev.x) : false) ||
        (next ? nearlyEqual(next.y, current.y) : false);
      const bend = preferVerticalFirst
        ? { x: prev.x, y: current.y }
        : { x: current.x, y: prev.y };

      if (!samePoint(prev, bend) && !samePoint(bend, current)) {
        result.push(bend);
      }
    }

    result.push(current);
  }

  return simplifyOrthogonalPolyline(result);
}

function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  return (
    withinPointRange(point.x, Math.min(a.x, b.x), Math.max(a.x, b.x)) &&
    withinPointRange(point.y, Math.min(a.y, b.y), Math.max(a.y, b.y))
  );
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const abVertical = nearlyEqual(a.x, b.x);
  const abHorizontal = nearlyEqual(a.y, b.y);
  const cdVertical = nearlyEqual(c.x, d.x);
  const cdHorizontal = nearlyEqual(c.y, d.y);

  if (abVertical && cdHorizontal) {
    const point = { x: a.x, y: c.y };
    return pointOnSegment(point, a, b) && pointOnSegment(point, c, d) ? point : null;
  }

  if (abHorizontal && cdVertical) {
    const point = { x: c.x, y: a.y };
    return pointOnSegment(point, a, b) && pointOnSegment(point, c, d) ? point : null;
  }

  if (abVertical && cdVertical && nearlyEqual(a.x, c.x)) {
    if (pointOnSegment(c, a, b)) return c;
    if (pointOnSegment(d, a, b)) return d;
    if (pointOnSegment(a, c, d)) return a;
    if (pointOnSegment(b, c, d)) return b;
  }

  if (abHorizontal && cdHorizontal && nearlyEqual(a.y, c.y)) {
    if (pointOnSegment(c, a, b)) return c;
    if (pointOnSegment(d, a, b)) return d;
    if (pointOnSegment(a, c, d)) return a;
    if (pointOnSegment(b, c, d)) return b;
  }

  return null;
}

function findLoopIntersection(
  points: Point[],
  nextPoint: Point
): { segmentIndex: number; point: Point } | null {
  if (points.length < 3) {
    return null;
  }

  const current = points[points.length - 1];
  for (let i = 0; i < points.length - 2; i++) {
    const point = segmentIntersection(points[i], points[i + 1], current, nextPoint);
    if (point && !samePoint(point, current)) {
      return { segmentIndex: i, point };
    }
  }

  return null;
}

function eraseOrthogonalLoops(points: Point[]): Point[] {
  const simplified = simplifyOrthogonalPolyline(points);
  if (simplified.length <= 3) {
    return simplified;
  }

  let result: Point[] = [simplified[0]];

  for (let i = 1; i < simplified.length; i++) {
    const nextPoint = simplified[i];
    let guard = 0;

    while (!samePoint(result[result.length - 1], nextPoint) && guard < simplified.length) {
      guard++;
      const hit = findLoopIntersection(result, nextPoint);

      if (!hit) {
        result.push(nextPoint);
        break;
      }

      result = result.slice(0, hit.segmentIndex + 1);
      if (!samePoint(result[result.length - 1], hit.point)) {
        result.push(hit.point);
      }

      if (samePoint(hit.point, nextPoint)) {
        break;
      }
    }
  }

  return simplifyOrthogonalPolyline(result);
}

/**
 * Put a polyline back into the canonical routed form: axis-aligned segments,
 * no duplicate or collinear vertices, no self-crossing loops.
 *
 * Exported because every stage that edits a polyline by hand (endpoint
 * anchoring, lane spreading) has to re-normalise afterwards, and calling it by
 * name says so -- routing against an empty obstacle list used to be the idiom,
 * which read as routing work that was not happening.
 */
export function normalizeRoutedPolyline(points: Point[]): Point[] {
  return eraseOrthogonalLoops(orthogonalizePolyline(points));
}

function inflateBox(box: NodeBox, margin: number): NodeBox {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

function segmentCrossesBox(a: Point, b: Point, box: NodeBox): boolean {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;

  if (nearlyEqual(a.y, b.y)) {
    return (
      withinSegmentInterior(a.y, top, bottom) &&
      rangesOverlap(Math.min(a.x, b.x), Math.max(a.x, b.x), left, right)
    );
  }

  if (nearlyEqual(a.x, b.x)) {
    return (
      withinSegmentInterior(a.x, left, right) &&
      rangesOverlap(Math.min(a.y, b.y), Math.max(a.y, b.y), top, bottom)
    );
  }

  return false;
}

function countObstacleCrossings(points: Point[], obstacles: NodeBox[]): number {
  let crossings = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (const obstacle of obstacles) {
      if (segmentCrossesBox(points[i], points[i + 1], obstacle)) {
        crossings++;
      }
    }
  }
  return crossings;
}

function findFirstObstacleCrossing(
  points: Point[],
  obstacles: NodeBox[]
): { segmentIndex: number; obstacle: NodeBox } | null {
  for (let i = 0; i < points.length - 1; i++) {
    for (const obstacle of obstacles) {
      if (segmentCrossesBox(points[i], points[i + 1], obstacle)) {
        return { segmentIndex: i, obstacle };
      }
    }
  }
  return null;
}

/**
 * Smallest box covering every input box.
 *
 * Deliberately loop-based: the spread form (`Math.min(...boxes.map(...))`)
 * allocates four throwaway arrays and overflows the call stack once the
 * obstacle list reaches a few tens of thousands of entries, which a large view
 * easily does. An empty input yields an empty box at the origin.
 */
export function boundingBox(boxes: readonly NodeBox[]): NodeBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const box of boxes) {
    if (box.x < left) left = box.x;
    if (box.y < top) top = box.y;
    if (box.x + box.width > right) right = box.x + box.width;
    if (box.y + box.height > bottom) bottom = box.y + box.height;
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function pointAtSegmentEndpoint(point: Point, a: Point, b: Point): boolean {
  return samePoint(point, a) || samePoint(point, b);
}

function countPolylineCrossings(points: Point[], referencePolylines: Point[][]): number {
  let crossings = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    for (const reference of referencePolylines) {
      for (let j = 0; j < reference.length - 1; j++) {
        const c = reference[j];
        const d = reference[j + 1];
        const intersection = segmentIntersection(a, b, c, d);

        if (!intersection) {
          continue;
        }

        if (
          pointAtSegmentEndpoint(intersection, a, b) &&
          pointAtSegmentEndpoint(intersection, c, d)
        ) {
          continue;
        }

        crossings++;
      }
    }
  }

  return crossings;
}

function chooseObstacleDetour(
  a: Point,
  b: Point,
  obstacle: NodeBox,
  obstacles: NodeBox[],
  referencePolylines: Point[][]
): Point[] {
  const candidates: Point[][] = [];
  const crossedObstacles = obstacles.filter((box) => segmentCrossesBox(a, b, box));
  const detourBox = boundingBox(crossedObstacles.length > 0 ? crossedObstacles : [obstacle]);

  if (nearlyEqual(a.y, b.y)) {
    const movingPositive = b.x >= a.x;
    const entryX = movingPositive ? detourBox.x : detourBox.x + detourBox.width;
    const exitX = movingPositive ? detourBox.x + detourBox.width : detourBox.x;

    for (const y of [detourBox.y, detourBox.y + detourBox.height]) {
      candidates.push(simplifyOrthogonalPolyline([
        a,
        { x: entryX, y: a.y },
        { x: entryX, y },
        { x: exitX, y },
        { x: exitX, y: b.y },
        b,
      ]));
    }
  } else if (nearlyEqual(a.x, b.x)) {
    const movingPositive = b.y >= a.y;
    const entryY = movingPositive ? detourBox.y : detourBox.y + detourBox.height;
    const exitY = movingPositive ? detourBox.y + detourBox.height : detourBox.y;

    for (const x of [detourBox.x, detourBox.x + detourBox.width]) {
      candidates.push(simplifyOrthogonalPolyline([
        a,
        { x: a.x, y: entryY },
        { x, y: entryY },
        { x, y: exitY },
        { x: b.x, y: exitY },
        b,
      ]));
    }
  }

  if (candidates.length === 0) {
    return [a, b];
  }

  return candidates.sort((left, right) => {
    const crossingDelta =
      countObstacleCrossings(left, obstacles) - countObstacleCrossings(right, obstacles);
    if (crossingDelta !== 0) {
      return crossingDelta;
    }

    const edgeCrossingDelta =
      countPolylineCrossings(left, referencePolylines) -
      countPolylineCrossings(right, referencePolylines);
    if (edgeCrossingDelta !== 0) {
      return edgeCrossingDelta;
    }

    const leftLength = polylineManhattanLength(left);
    const rightLength = polylineManhattanLength(right);
    return leftLength - rightLength;
  })[0];
}

function polylineManhattanLength(points: Point[]): number {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    length += manhattanLength(points[i], points[i + 1]);
  }
  return length;
}

function routeByLocalObstacleDetours(
  points: Point[],
  obstacles: NodeBox[],
  referencePolylines: Point[][]
): Point[] {
  let routed = normalizeRoutedPolyline(points);

  for (let pass = 0; pass < MAX_OBSTACLE_REROUTE_PASSES; pass++) {
    const hit = findFirstObstacleCrossing(routed, obstacles);
    if (!hit) {
      return routed;
    }

    const a = routed[hit.segmentIndex];
    const b = routed[hit.segmentIndex + 1];
    const detour = chooseObstacleDetour(a, b, hit.obstacle, obstacles, referencePolylines);
    routed = normalizeRoutedPolyline([
      ...routed.slice(0, hit.segmentIndex),
      ...detour,
      ...routed.slice(hit.segmentIndex + 2),
    ]);
  }

  return routed;
}

export function routePolylineAroundObstacles(
  points: Point[],
  obstacles: NodeBox[],
  referencePolylines: Point[][] = []
): Point[] {
  if (points.length < 2 || obstacles.length === 0) {
    return ensureDrawablePolyline(normalizeRoutedPolyline(points), points);
  }

  const inflatedObstacles = obstacles.map((box) => inflateBox(box, NODE_OBSTACLE_MARGIN));
  const normalized = normalizeRoutedPolyline(points);
  return ensureDrawablePolyline(
    routeByLocalObstacleDetours(normalized, inflatedObstacles, referencePolylines),
    points
  );
}

/**
 * Normalization (orthogonalize + loop erasure) can collapse a degenerate
 * polyline below 2 points -- e.g. while dragging a node on top of its edge
 * partner both endpoints coincide. Fall back to the original endpoints so
 * callers can always draw a segment (a zero-length one renders as nothing).
 */
export function ensureDrawablePolyline(routed: Point[], original: Point[]): Point[] {
  if (routed.length >= 2 || original.length < 2) {
    return routed;
  }
  return [original[0], original[original.length - 1]];
}

function segmentMatchesAnchorAxis(from: Point, to: Point, side: EdgeAnchorSide): boolean {
  return isHorizontalSide(side)
    ? nearlyEqual(from.y, to.y)
    : nearlyEqual(from.x, to.x);
}

function segmentMovesWithAnchorSide(from: Point, to: Point, side: EdgeAnchorSide): boolean {
  switch (side) {
    case "left":
      return to.x <= from.x + POINT_TOLERANCE;
    case "right":
      return to.x >= from.x - POINT_TOLERANCE;
    case "top":
      return to.y <= from.y + POINT_TOLERANCE;
    case "bottom":
      return to.y >= from.y - POINT_TOLERANCE;
  }
}

function polylineRespectsAnchorDirections(
  points: Point[],
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): boolean {
  if (points.length < 2) {
    return false;
  }

  const startPoint = points[0];
  const nextPoint = points[1];
  const endPoint = points[points.length - 1];
  const prevPoint = points[points.length - 2];

  return (
    segmentMatchesAnchorAxis(startPoint, nextPoint, sourceAnchor.side) &&
    segmentMovesWithAnchorSide(startPoint, nextPoint, sourceAnchor.side) &&
    segmentMatchesAnchorAxis(endPoint, prevPoint, targetAnchor.side) &&
    segmentMovesWithAnchorSide(endPoint, prevPoint, targetAnchor.side)
  );
}

function alignStartWithAnchor(points: Point[], startPoint: Point, side: EdgeAnchorSide): Point[] {
  if (points.length < 2) {
    return [startPoint];
  }

  const nextPoint = points[1];
  const result: Point[] = [startPoint];

  if (side === "left" || side === "right") {
    if (!nearlyEqual(nextPoint.y, startPoint.y)) {
      result.push({ x: nextPoint.x, y: startPoint.y });
    }
  } else if (!nearlyEqual(nextPoint.x, startPoint.x)) {
    result.push({ x: startPoint.x, y: nextPoint.y });
  }

  result.push(...points.slice(1));
  return result;
}

function alignEndWithAnchor(points: Point[], endPoint: Point, side: EdgeAnchorSide): Point[] {
  if (points.length < 2) {
    return [endPoint];
  }

  const prevPoint = points[points.length - 2];
  const result = points.slice(0, -1);

  if (side === "left" || side === "right") {
    if (!nearlyEqual(prevPoint.y, endPoint.y)) {
      result.push({ x: prevPoint.x, y: endPoint.y });
    }
  } else if (!nearlyEqual(prevPoint.x, endPoint.x)) {
    result.push({ x: endPoint.x, y: prevPoint.y });
  }

  result.push(endPoint);
  return result;
}

/**
 * The outcome of anchoring a polyline, with the escalation made visible.
 *
 * `rerouted` is the load-bearing bit: it says the incoming route was DISCARDED
 * and replaced by a freshly synthesised orthogonal one, rather than nudged onto
 * its anchors. That used to happen silently inside `anchorEdgePolyline`, so a
 * caller had no way to tell whether the geometry it got back still resembled
 * what the layout produced.
 */
export interface AnchoredPolyline {
  points: Point[];
  rerouted: boolean;
}

/**
 * Snap a polyline's endpoints onto the given anchors.
 *
 * The happy path aligns the first and last segments onto the anchor points and
 * re-normalises. When the result would leave or enter a node from a direction
 * its anchor forbids -- a stale bend, a node dragged past its own edge -- the
 * route cannot be salvaged by nudging and is replaced wholesale by
 * `rerouteOrthogonalEdge`. The return value reports which of the two happened.
 */
export function anchorEdgePolyline(
  points: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): AnchoredPolyline {
  if (points.length < 2) {
    return { points: points.slice(), rerouted: false };
  }

  const withStart = alignStartWithAnchor(
    dedupePolylinePoints(points),
    getAnchorPoint(sourceBox, sourceAnchor),
    sourceAnchor.side
  );

  const withEnd = alignEndWithAnchor(
    withStart,
    getAnchorPoint(targetBox, targetAnchor),
    targetAnchor.side
  );

  const anchored = normalizeRoutedPolyline(withEnd);
  if (polylineRespectsAnchorDirections(anchored, sourceAnchor, targetAnchor)) {
    return { points: anchored, rerouted: false };
  }

  return {
    points: rerouteOrthogonalEdge(
      points,
      sourceBox,
      targetBox,
      sourceAnchor,
      targetAnchor
    ),
    rerouted: true,
  };
}

function getSideNormal(side: EdgeAnchorSide): Point {
  switch (side) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
  }
}

function translatePoint(point: Point, dx: number, dy: number): Point {
  return {
    x: point.x + dx,
    y: point.y + dy,
  };
}

export function translatePolyline(points: Point[], dx: number, dy: number): Point[] {
  return points.map((point) => translatePoint(point, dx, dy));
}

function manhattanLength(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function getLeadDistance(points: Point[], fromStart: boolean): number {
  if (points.length < 2) {
    return 28;
  }

  const a = fromStart ? points[0] : points[points.length - 1];
  const b = fromStart ? points[1] : points[points.length - 2];
  return clamp(manhattanLength(a, b), MIN_LEAD_DISTANCE, MAX_LEAD_DISTANCE);
}

function offsetFromAnchor(point: Point, side: EdgeAnchorSide, distance: number): Point {
  const normal = getSideNormal(side);
  return {
    x: point.x + normal.x * distance,
    y: point.y + normal.y * distance,
  };
}

function collectTrackValues(points: Point[], orientation: "vertical" | "horizontal"): number[] {
  const values: number[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];

    if (
      orientation === "vertical" &&
      nearlyEqual(current.x, next.x) &&
      !nearlyEqual(current.y, next.y)
    ) {
      values.push(current.x);
    }

    if (
      orientation === "horizontal" &&
      nearlyEqual(current.y, next.y) &&
      !nearlyEqual(current.x, next.x)
    ) {
      values.push(current.y);
    }
  }

  return values;
}

function getPreferredTrack(
  points: Point[],
  orientation: "vertical" | "horizontal",
  fallback: number
): number {
  const values = collectTrackValues(points, orientation);
  return values.length > 0 ? median(values) : fallback;
}

function chooseOutsideCoordinate(
  preferred: number,
  negativeOption: number,
  positiveOption: number
): number {
  return Math.abs(preferred - negativeOption) <= Math.abs(preferred - positiveOption)
    ? negativeOption
    : positiveOption;
}

function canDirectlyConnectLeads(
  startLead: Point,
  endLead: Point,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): boolean {
  const aligned = nearlyEqual(startLead.x, endLead.x) || nearlyEqual(startLead.y, endLead.y);
  if (!aligned) {
    return false;
  }

  return (
    segmentMatchesAnchorAxis(startLead, endLead, sourceAnchor.side) &&
    segmentMovesWithAnchorSide(startLead, endLead, sourceAnchor.side) &&
    segmentMatchesAnchorAxis(endLead, startLead, targetAnchor.side) &&
    segmentMovesWithAnchorSide(endLead, startLead, targetAnchor.side)
  );
}

function routeHorizontalSides(
  originalPoints: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor,
  startLead: Point,
  endLead: Point
): Point[] {
  const preferredX = getPreferredTrack(
    originalPoints,
    "vertical",
    (startLead.x + endLead.x) / 2
  );
  const preferredY = getPreferredTrack(
    originalPoints,
    "horizontal",
    (startLead.y + endLead.y) / 2
  );

  if (sourceAnchor.side === targetAnchor.side) {
    if (nearlyEqual(startLead.y, endLead.y)) {
      const detourY = chooseOutsideCoordinate(
        preferredY,
        Math.min(sourceBox.y, targetBox.y) - DETOUR_GUTTER,
        Math.max(sourceBox.y + sourceBox.height, targetBox.y + targetBox.height) + DETOUR_GUTTER
      );

      return [
        startLead,
        { x: startLead.x, y: detourY },
        { x: endLead.x, y: detourY },
        endLead,
      ];
    }

    const x =
      sourceAnchor.side === "right"
        ? Math.max(preferredX, startLead.x, endLead.x)
        : Math.min(preferredX, startLead.x, endLead.x);

    return [
      startLead,
      { x, y: startLead.y },
      { x, y: endLead.y },
      endLead,
    ];
  }

  const corridorExists =
    (sourceAnchor.side === "right" && startLead.x <= endLead.x) ||
    (sourceAnchor.side === "left" && startLead.x >= endLead.x);

  if (corridorExists && canDirectlyConnectLeads(startLead, endLead, sourceAnchor, targetAnchor)) {
    return [startLead, endLead];
  }

  if (corridorExists) {
    const x = clamp(
      preferredX,
      Math.min(startLead.x, endLead.x),
      Math.max(startLead.x, endLead.x)
    );

    return [
      startLead,
      { x, y: startLead.y },
      { x, y: endLead.y },
      endLead,
    ];
  }

  const detourY = chooseOutsideCoordinate(
    preferredY,
    Math.min(sourceBox.y, targetBox.y) - DETOUR_GUTTER,
    Math.max(sourceBox.y + sourceBox.height, targetBox.y + targetBox.height) + DETOUR_GUTTER
  );

  return [
    startLead,
    { x: startLead.x, y: detourY },
    { x: endLead.x, y: detourY },
    endLead,
  ];
}

function routeVerticalSides(
  originalPoints: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor,
  startLead: Point,
  endLead: Point
): Point[] {
  const preferredY = getPreferredTrack(
    originalPoints,
    "horizontal",
    (startLead.y + endLead.y) / 2
  );
  const preferredX = getPreferredTrack(
    originalPoints,
    "vertical",
    (startLead.x + endLead.x) / 2
  );

  if (sourceAnchor.side === targetAnchor.side) {
    if (nearlyEqual(startLead.x, endLead.x)) {
      const detourX = chooseOutsideCoordinate(
        preferredX,
        Math.min(sourceBox.x, targetBox.x) - DETOUR_GUTTER,
        Math.max(sourceBox.x + sourceBox.width, targetBox.x + targetBox.width) + DETOUR_GUTTER
      );

      return [
        startLead,
        { x: detourX, y: startLead.y },
        { x: detourX, y: endLead.y },
        endLead,
      ];
    }

    const y =
      sourceAnchor.side === "bottom"
        ? Math.max(preferredY, startLead.y, endLead.y)
        : Math.min(preferredY, startLead.y, endLead.y);

    return [
      startLead,
      { x: startLead.x, y },
      { x: endLead.x, y },
      endLead,
    ];
  }

  const corridorExists =
    (sourceAnchor.side === "bottom" && startLead.y <= endLead.y) ||
    (sourceAnchor.side === "top" && startLead.y >= endLead.y);

  if (corridorExists && canDirectlyConnectLeads(startLead, endLead, sourceAnchor, targetAnchor)) {
    return [startLead, endLead];
  }

  if (corridorExists) {
    const y = clamp(
      preferredY,
      Math.min(startLead.y, endLead.y),
      Math.max(startLead.y, endLead.y)
    );

    return [
      startLead,
      { x: startLead.x, y },
      { x: endLead.x, y },
      endLead,
    ];
  }

  const detourX = chooseOutsideCoordinate(
    preferredX,
    Math.min(sourceBox.x, targetBox.x) - DETOUR_GUTTER,
    Math.max(sourceBox.x + sourceBox.width, targetBox.x + targetBox.width) + DETOUR_GUTTER
  );

  return [
    startLead,
    { x: detourX, y: startLead.y },
    { x: detourX, y: endLead.y },
    endLead,
  ];
}

/**
 * Compute the minimum distance from a point to any segment in a polyline.
 * Used for edge hover hit-testing.
 */
export function pointToPolylineDistance(point: Point, polyline: Point[]): number {
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const dist = pointToSegmentDistance(point, polyline[i], polyline[i + 1]);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function rerouteOrthogonalEdge(
  originalPoints: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): Point[] {
  const startPoint = getAnchorPoint(sourceBox, sourceAnchor);
  const endPoint = getAnchorPoint(targetBox, targetAnchor);
  const startLead = offsetFromAnchor(
    startPoint,
    sourceAnchor.side,
    getLeadDistance(originalPoints, true)
  );
  const endLead = offsetFromAnchor(
    endPoint,
    targetAnchor.side,
    getLeadDistance(originalPoints, false)
  );

  let middlePoints: Point[];

  if (canDirectlyConnectLeads(startLead, endLead, sourceAnchor, targetAnchor)) {
    middlePoints = [startLead, endLead];
  } else if (isHorizontalSide(sourceAnchor.side) && isHorizontalSide(targetAnchor.side)) {
    middlePoints = routeHorizontalSides(
      originalPoints,
      sourceBox,
      targetBox,
      sourceAnchor,
      targetAnchor,
      startLead,
      endLead
    );
  } else if (isVerticalSide(sourceAnchor.side) && isVerticalSide(targetAnchor.side)) {
    middlePoints = routeVerticalSides(
      originalPoints,
      sourceBox,
      targetBox,
      sourceAnchor,
      targetAnchor,
      startLead,
      endLead
    );
  } else if (isHorizontalSide(sourceAnchor.side)) {
    middlePoints = [
      startLead,
      { x: startLead.x, y: endLead.y },
      endLead,
    ];
  } else {
    middlePoints = [
      startLead,
      { x: endLead.x, y: startLead.y },
      endLead,
    ];
  }

  return normalizeRoutedPolyline([
    startPoint,
    ...middlePoints,
    endPoint,
  ]);
}
