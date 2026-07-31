/**
 * Count chips for aggregated ("bundled") edges.
 *
 * When a container is collapsed the backend returns a single aggregated edge
 * carrying the number of underlying edges it stands for. Edge stroke width
 * already scales with log2(count), but that difference is easy to miss, so
 * every rendered edge with `count > 1` also gets a small "×N" chip drawn at the
 * arc-length midpoint of its routed polyline.
 *
 * Chips live in world space inside the edge layers, so they scale with zoom and
 * are rebuilt exactly when the edges they annotate are rebuilt (layout,
 * visibility, LOD, drag, hover). Nothing here runs per frame.
 */

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Point } from "../layout/edgeGeometry";
import type { LODLevel } from "../../stores/viewportStore";

/** Everything needed to draw one chip; computed by the edge drawing pass. */
export interface EdgeCountChipSpec {
  /** World-space position of the chip centre (the edge's arc-length midpoint). */
  position: Point;
  /** Aggregated edge count; always > 1 for a rendered chip. */
  count: number;
  /** Edge colour, used for the chip border and text tint. */
  color: number;
  /** Alpha the edge itself was drawn at; the chip never renders brighter. */
  alpha: number;
}

const CHIP_FONT_SIZE = 10;
const CHIP_PADDING_X = 4;
const CHIP_PADDING_Y = 2;
const CHIP_CORNER_RADIUS = 4;
/** Matches the dark slate used by the tooltip/panel chrome. */
const CHIP_BACKGROUND_COLOR = 0x1e293b;
const CHIP_BACKGROUND_ALPHA = 0.92;
const CHIP_BORDER_WIDTH = 1;
const CHIP_BORDER_ALPHA = 0.9;
/** Text is rendered at 2x so it stays legible when the viewport zooms in. */
const CHIP_TEXT_RESOLUTION = 2;

/**
 * Shared text style for every chip. Created lazily so importing this module in
 * a non-DOM environment (tests) never touches Pixi's text machinery.
 * The per-edge colour is applied via `Text.tint`, not by cloning the style.
 */
let cachedChipTextStyle: TextStyle | null = null;

function chipTextStyle(): TextStyle {
  if (!cachedChipTextStyle) {
    cachedChipTextStyle = new TextStyle({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: CHIP_FONT_SIZE,
      fontWeight: "600",
      // White so `tint` reproduces the edge colour exactly.
      fill: "#ffffff",
    });
  }
  return cachedChipTextStyle;
}

/** Chip label for an aggregated edge, e.g. `×12`. */
export function formatEdgeCount(count: number): string {
  return `×${count}`;
}

/**
 * Whether an edge should carry a count chip.
 *
 * Chips are for aggregated edges only (`count > 1`) and only at the "detail"
 * LOD -- at "overview" and "minimap" the graph is too dense for per-edge text.
 */
export function shouldShowCountChip(count: number, lod: LODLevel): boolean {
  if (lod !== "detail") return false;
  return Number.isInteger(count) && count > 1;
}

/**
 * Alpha for a chip drawn on an edge rendered at `edgeAlpha`.
 *
 * Chips must never read brighter than the edge they annotate, so ambiguous
 * (dimmed) and LOD-faded edges carry proportionally faded chips.
 */
export function chipAlphaForEdge(edgeAlpha: number): number {
  if (!Number.isFinite(edgeAlpha)) return 0;
  return Math.min(1, Math.max(0, edgeAlpha));
}

/**
 * The point at half the total arc length of a polyline.
 *
 * This is deliberately not the middle *vertex*: routed orthogonal edges have
 * wildly uneven segment lengths, so the middle vertex often sits in a corner.
 *
 * Returns `null` only for an empty polyline. A polyline whose total length is
 * zero (all points coincident, which routing can produce mid-drag) resolves to
 * its first point. The returned point is always a fresh object.
 */
export function polylineArcMidpoint(points: readonly Point[]): Point | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { x: points[0].x, y: points[0].y };

  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i++) {
    totalLength += Math.hypot(
      points[i + 1].x - points[i].x,
      points[i + 1].y - points[i].y
    );
  }

  if (totalLength <= 0) {
    return { x: points[0].x, y: points[0].y };
  }

  const halfLength = totalLength / 2;
  let travelled = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const segmentLength = Math.hypot(to.x - from.x, to.y - from.y);
    if (segmentLength <= 0) continue;

    if (travelled + segmentLength >= halfLength) {
      const t = (halfLength - travelled) / segmentLength;
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
    }

    travelled += segmentLength;
  }

  // Unreachable for a positive-length polyline; kept as a total fallback.
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * Build a single chip: a rounded dark plate outlined in the edge colour with
 * the "×N" label centred on it. The chip is centred on `spec.position`.
 */
export function createEdgeCountChip(spec: EdgeCountChipSpec): Container {
  const chip = new Container();
  chip.eventMode = "none";

  const label = new Text({
    text: formatEdgeCount(spec.count),
    style: chipTextStyle(),
    resolution: CHIP_TEXT_RESOLUTION,
  });
  label.tint = spec.color;
  label.anchor.set(0.5);

  const width = label.width + CHIP_PADDING_X * 2;
  const height = label.height + CHIP_PADDING_Y * 2;

  const background = new Graphics();
  background.roundRect(-width / 2, -height / 2, width, height, CHIP_CORNER_RADIUS);
  background.fill({ color: CHIP_BACKGROUND_COLOR, alpha: CHIP_BACKGROUND_ALPHA });
  background.stroke({
    color: spec.color,
    width: CHIP_BORDER_WIDTH,
    alpha: CHIP_BORDER_ALPHA,
  });

  chip.addChild(background);
  chip.addChild(label);
  chip.x = spec.position.x;
  chip.y = spec.position.y;
  chip.alpha = chipAlphaForEdge(spec.alpha);

  return chip;
}

/**
 * Build the container holding every chip for one edge layer, or `null` when
 * there is nothing to draw. Allocation is bounded by the number of aggregated
 * edges in the current view, which is small by construction.
 */
export function buildEdgeCountChipLayer(
  specs: readonly EdgeCountChipSpec[]
): Container | null {
  if (specs.length === 0) return null;

  const layer = new Container();
  layer.eventMode = "none";
  for (const spec of specs) {
    layer.addChild(createEdgeCountChip(spec));
  }
  return layer;
}
