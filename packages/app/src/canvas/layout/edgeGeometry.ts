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

const BOUNDARY_TOLERANCE = 4;
const POINT_TOLERANCE = 0.5;
const MIN_LEAD_DISTANCE = 18;
const MAX_LEAD_DISTANCE = 72;
const DETOUR_GUTTER = 28;
const NODE_OBSTACLE_MARGIN = 14;
const MAX_OBSTACLE_REROUTE_PASSES = 12;

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

function inferApproachSide(
  nodeBox: NodeBox,
  boundaryPoint: Point,
  adjacentPoint: Point
): EdgeAnchorSide | null {
  const dx = adjacentPoint.x - boundaryPoint.x;
  const dy = adjacentPoint.y - boundaryPoint.y;
  const xWithinNode = withinRange(boundaryPoint.x, nodeBox.x, nodeBox.x + nodeBox.width);
  const yWithinNode = withinRange(boundaryPoint.y, nodeBox.y, nodeBox.y + nodeBox.height);
  const verticalApproach =
    Math.abs(dy) > POINT_TOLERANCE &&
    (Math.abs(dy) >= Math.abs(dx) || nearlyEqual(boundaryPoint.x, adjacentPoint.x, BOUNDARY_TOLERANCE));
  const horizontalApproach =
    Math.abs(dx) > POINT_TOLERANCE &&
    (Math.abs(dx) > Math.abs(dy) || nearlyEqual(boundaryPoint.y, adjacentPoint.y, BOUNDARY_TOLERANCE));

  if (verticalApproach && xWithinNode) {
    if (dy < 0 && adjacentPoint.y <= nodeBox.y + BOUNDARY_TOLERANCE) {
      return "top";
    }
    if (dy > 0 && adjacentPoint.y >= nodeBox.y + nodeBox.height - BOUNDARY_TOLERANCE) {
      return "bottom";
    }
  }

  if (horizontalApproach && yWithinNode) {
    if (dx < 0 && adjacentPoint.x <= nodeBox.x + BOUNDARY_TOLERANCE) {
      return "left";
    }
    if (dx > 0 && adjacentPoint.x >= nodeBox.x + nodeBox.width - BOUNDARY_TOLERANCE) {
      return "right";
    }
  }

  return null;
}

function inferAnchorSide(
  nodeBox: NodeBox,
  boundaryPoint: Point,
  adjacentPoint: Point
): EdgeAnchorSide {
  const approachSide = inferApproachSide(nodeBox, boundaryPoint, adjacentPoint);
  if (approachSide) {
    return approachSide;
  }

  if (Math.abs(boundaryPoint.x - nodeBox.x) <= BOUNDARY_TOLERANCE) {
    return "left";
  }
  if (Math.abs(boundaryPoint.x - (nodeBox.x + nodeBox.width)) <= BOUNDARY_TOLERANCE) {
    return "right";
  }
  if (Math.abs(boundaryPoint.y - nodeBox.y) <= BOUNDARY_TOLERANCE) {
    return "top";
  }
  if (Math.abs(boundaryPoint.y - (nodeBox.y + nodeBox.height)) <= BOUNDARY_TOLERANCE) {
    return "bottom";
  }

  const dx = adjacentPoint.x - boundaryPoint.x;
  const dy = adjacentPoint.y - boundaryPoint.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

export function inferEdgeAnchor(
  nodeBox: NodeBox,
  boundaryPoint: Point,
  adjacentPoint: Point
): EdgeAnchor {
  const side = inferAnchorSide(nodeBox, boundaryPoint, adjacentPoint);

  return {
    side,
    offset:
      side === "left" || side === "right"
        ? clamp(boundaryPoint.y - nodeBox.y, 0, nodeBox.height)
        : clamp(boundaryPoint.x - nodeBox.x, 0, nodeBox.width),
  };
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

function normalizeRoutedPolyline(points: Point[]): Point[] {
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

function chooseObstacleDetour(
  a: Point,
  b: Point,
  obstacle: NodeBox,
  obstacles: NodeBox[]
): Point[] {
  const candidates: Point[][] = [];

  if (nearlyEqual(a.y, b.y)) {
    const movingPositive = b.x >= a.x;
    const entryX = movingPositive ? obstacle.x : obstacle.x + obstacle.width;
    const exitX = movingPositive ? obstacle.x + obstacle.width : obstacle.x;

    for (const y of [obstacle.y, obstacle.y + obstacle.height]) {
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
    const entryY = movingPositive ? obstacle.y : obstacle.y + obstacle.height;
    const exitY = movingPositive ? obstacle.y + obstacle.height : obstacle.y;

    for (const x of [obstacle.x, obstacle.x + obstacle.width]) {
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
  obstacles: NodeBox[]
): Point[] {
  let routed = normalizeRoutedPolyline(points);

  for (let pass = 0; pass < MAX_OBSTACLE_REROUTE_PASSES; pass++) {
    const hit = findFirstObstacleCrossing(routed, obstacles);
    if (!hit) {
      return routed;
    }

    const a = routed[hit.segmentIndex];
    const b = routed[hit.segmentIndex + 1];
    const detour = chooseObstacleDetour(a, b, hit.obstacle, obstacles);
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
  obstacles: NodeBox[]
): Point[] {
  if (points.length < 2 || obstacles.length === 0) {
    return normalizeRoutedPolyline(points);
  }

  const inflatedObstacles = obstacles.map((box) => inflateBox(box, NODE_OBSTACLE_MARGIN));
  const normalized = normalizeRoutedPolyline(points);
  return routeByLocalObstacleDetours(normalized, inflatedObstacles);
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

export function anchorEdgePolyline(
  points: Point[],
  sourceBox: NodeBox,
  targetBox: NodeBox,
  sourceAnchor: EdgeAnchor,
  targetAnchor: EdgeAnchor
): Point[] {
  if (points.length < 2) {
    return points.slice();
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
    return anchored;
  }

  return rerouteOrthogonalEdge(
    points,
    sourceBox,
    targetBox,
    sourceAnchor,
    targetAnchor
  );
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
