/**
 * Spatial index over the obstacle boxes an edge has to route around.
 *
 * The edge re-routing pass used to build the obstacle list PER EDGE by scanning
 * every visible node, which is O(E x N) and allocates hundreds of millions of
 * short-lived boxes on a large view. Instead the caller now builds the obstacle
 * set ONCE per redraw and hands it to this index; each edge then asks only for
 * the obstacles near its own polyline (O(log N) per query).
 *
 * Every box carries the id of the node it came from (a node contributes its
 * body box and, when labelled, its label box), so an edge can exclude the
 * obstacles belonging to its own endpoints in one shot.
 *
 * Dependency-free apart from rbush: no other src module is imported at runtime,
 * so this module loads under `node --test`.
 */

import RBush from "rbush";
import type { NodeBox, Point } from "./edgeGeometry";

/** Axis-aligned query window in layout coordinates. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One indexed obstacle: an rbush-shaped bbox plus its owning node and box. */
export interface ObstacleEntry extends Bounds {
  /** Node this box belongs to. Both a node's body and its label share one id. */
  ownerId: string;
  box: NodeBox;
}

/** Wrap a box as an indexable entry owned by `ownerId`. */
export function obstacleEntry(ownerId: string, box: NodeBox): ObstacleEntry {
  return {
    minX: box.x,
    minY: box.y,
    maxX: box.x + box.width,
    maxY: box.y + box.height,
    ownerId,
    box,
  };
}

/**
 * Bounding window of a polyline, inflated by `margin`.
 *
 * The margin is what keeps detours honest: the router may leave the straight
 * corridor between the endpoints, so obstacles slightly off the path still have
 * to be visible to it. Returns null for an empty polyline (nothing to query).
 */
export function polylineBounds(
  points: readonly Point[],
  margin = 0
): Bounds | null {
  if (points.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}

/**
 * Immutable R-tree over a redraw's obstacle boxes.
 *
 * Built once per full edge redraw and queried once per edge. Entries are bulk
 * loaded, which builds a better-balanced tree than repeated inserts.
 */
export class ObstacleIndex {
  private readonly tree = new RBush<ObstacleEntry>();
  private readonly count: number;

  constructor(entries: readonly ObstacleEntry[]) {
    this.count = entries.length;
    if (entries.length > 0) {
      this.tree.load(entries.slice());
    }
  }

  /** Number of indexed boxes (not nodes: a labelled node contributes two). */
  get size(): number {
    return this.count;
  }

  /**
   * Boxes intersecting `bounds`, minus those owned by the (up to two) excluded
   * nodes. Touching the window counts as intersecting.
   */
  query(
    bounds: Bounds,
    excludeOwnerA?: string | null,
    excludeOwnerB?: string | null
  ): NodeBox[] {
    if (this.count === 0) {
      return [];
    }

    const hits = this.tree.search(bounds);
    const boxes: NodeBox[] = [];

    for (const hit of hits) {
      if (hit.ownerId === excludeOwnerA || hit.ownerId === excludeOwnerB) {
        continue;
      }
      boxes.push(hit.box);
    }

    return boxes;
  }

  /**
   * Boxes near `points` -- the polyline's bounding window widened by `margin`.
   * This is the per-edge call in the redraw loop.
   */
  queryForPolyline(
    points: readonly Point[],
    margin: number,
    excludeOwnerA?: string | null,
    excludeOwnerB?: string | null
  ): NodeBox[] {
    const bounds = polylineBounds(points, margin);
    if (!bounds) {
      return [];
    }
    return this.query(bounds, excludeOwnerA, excludeOwnerB);
  }
}
