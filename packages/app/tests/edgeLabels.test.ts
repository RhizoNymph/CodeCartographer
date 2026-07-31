import assert from "node:assert/strict";
import test from "node:test";

import {
  chipAlphaForEdge,
  formatEdgeCount,
  polylineArcMidpoint,
  shouldShowCountChip,
} from "../src/canvas/renderers/edgeLabels.ts";

import type { Point } from "../src/canvas/layout/edgeGeometry.ts";

/**
 * Tests for the aggregated-edge count chip helpers.
 *
 * Only the pure functions are exercised here: chip rendering itself needs a
 * WebGL/canvas context (Pixi Text measurement) that is unavailable in the Node
 * test runner, so the drawing path is kept as a thin shell over these.
 */

// ---------------------------------------------------------------------------
// polylineArcMidpoint
// ---------------------------------------------------------------------------

test("polylineArcMidpoint returns null for an empty polyline", () => {
  assert.equal(polylineArcMidpoint([]), null);
});

test("polylineArcMidpoint returns the single point for a one-point polyline", () => {
  const midpoint = polylineArcMidpoint([{ x: 7, y: -3 }]);
  assert.deepEqual(midpoint, { x: 7, y: -3 });
});

test("polylineArcMidpoint returns a copy, not the input point", () => {
  const points: Point[] = [{ x: 1, y: 2 }];
  const midpoint = polylineArcMidpoint(points)!;
  midpoint.x = 999;
  assert.equal(points[0].x, 1);
});

test("polylineArcMidpoint bisects a straight two-point segment", () => {
  const midpoint = polylineArcMidpoint([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  assert.deepEqual(midpoint, { x: 50, y: 0 });
});

test("polylineArcMidpoint bisects a diagonal two-point segment", () => {
  const midpoint = polylineArcMidpoint([
    { x: -10, y: -10 },
    { x: 10, y: 10 },
  ]);
  assert.deepEqual(midpoint, { x: 0, y: 0 });
});

test("polylineArcMidpoint uses arc length, not the middle vertex", () => {
  // Segment lengths: 2 then 8 (total 10). Half-length (5) lands 3 units up the
  // second segment -- NOT on the middle vertex at (2, 0).
  const midpoint = polylineArcMidpoint([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 8 },
  ])!;
  assert.equal(midpoint.x, 2);
  assert.equal(midpoint.y, 3);
});

test("polylineArcMidpoint can land exactly on a vertex when arc lengths are equal", () => {
  const midpoint = polylineArcMidpoint([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ])!;
  assert.equal(midpoint.x, 10);
  assert.equal(midpoint.y, 0);
});

test("polylineArcMidpoint handles many segments", () => {
  // Five unit segments to the right; total length 5, half is 2.5.
  const points: Point[] = [];
  for (let i = 0; i <= 5; i++) {
    points.push({ x: i, y: 0 });
  }
  const midpoint = polylineArcMidpoint(points)!;
  assert.equal(midpoint.x, 2.5);
  assert.equal(midpoint.y, 0);
});

test("polylineArcMidpoint skips zero-length segments", () => {
  const midpoint = polylineArcMidpoint([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 0 },
  ])!;
  assert.equal(midpoint.x, 2);
  assert.equal(midpoint.y, 0);
});

test("polylineArcMidpoint returns the first point when the polyline is degenerate", () => {
  // Every point coincides -- total arc length is zero.
  const midpoint = polylineArcMidpoint([
    { x: 5, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 5 },
  ])!;
  assert.deepEqual(midpoint, { x: 5, y: 5 });
});

test("polylineArcMidpoint is symmetric under reversal", () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 40 },
    { x: 60, y: 40 },
  ];
  const forward = polylineArcMidpoint(points)!;
  const backward = polylineArcMidpoint([...points].reverse())!;
  assert.ok(Math.abs(forward.x - backward.x) < 1e-9);
  assert.ok(Math.abs(forward.y - backward.y) < 1e-9);
});

// ---------------------------------------------------------------------------
// shouldShowCountChip
// ---------------------------------------------------------------------------

test("shouldShowCountChip requires an aggregated count above 1", () => {
  assert.equal(shouldShowCountChip(0, "detail"), false);
  assert.equal(shouldShowCountChip(1, "detail"), false);
  assert.equal(shouldShowCountChip(2, "detail"), true);
  assert.equal(shouldShowCountChip(37, "detail"), true);
});

test("shouldShowCountChip hides chips outside the detail LOD", () => {
  assert.equal(shouldShowCountChip(9, "overview"), false);
  assert.equal(shouldShowCountChip(9, "minimap"), false);
});

test("shouldShowCountChip rejects non-finite and fractional counts", () => {
  assert.equal(shouldShowCountChip(Number.NaN, "detail"), false);
  assert.equal(shouldShowCountChip(Number.POSITIVE_INFINITY, "detail"), false);
  assert.equal(shouldShowCountChip(1.5, "detail"), false);
});

// ---------------------------------------------------------------------------
// chipAlphaForEdge
// ---------------------------------------------------------------------------

test("chipAlphaForEdge never exceeds the alpha of the edge it labels", () => {
  for (const edgeAlpha of [0.05, 0.3, 0.45, 0.8, 1]) {
    assert.ok(chipAlphaForEdge(edgeAlpha) <= edgeAlpha);
  }
});

test("chipAlphaForEdge clamps out-of-range input", () => {
  assert.equal(chipAlphaForEdge(-1), 0);
  assert.equal(chipAlphaForEdge(4), 1);
  assert.equal(chipAlphaForEdge(Number.NaN), 0);
});

test("chipAlphaForEdge matches a dimmed ambiguous edge", () => {
  // 0.8 base * 0.45 ambiguous multiplier
  assert.ok(Math.abs(chipAlphaForEdge(0.36) - 0.36) < 1e-9);
});

// ---------------------------------------------------------------------------
// formatEdgeCount
// ---------------------------------------------------------------------------

test("formatEdgeCount renders a multiplication-sign prefixed count", () => {
  assert.equal(formatEdgeCount(2), "×2");
  assert.equal(formatEdgeCount(140), "×140");
});
