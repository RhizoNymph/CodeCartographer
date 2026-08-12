import assert from "node:assert/strict";
import test from "node:test";

import {
  ObstacleIndex,
  obstacleEntry,
  polylineBounds,
} from "../src/canvas/layout/obstacleIndex.ts";
import type { NodeBox, Point } from "../src/canvas/layout/edgeGeometry.ts";

function box(x: number, y: number, width: number, height: number): NodeBox {
  return { x, y, width, height };
}

function sortBoxes(boxes: NodeBox[]): NodeBox[] {
  return boxes.slice().sort((a, b) => a.x - b.x || a.y - b.y);
}

// ---------------------------------------------------------------------------
// polylineBounds
// ---------------------------------------------------------------------------

test("polylineBounds returns null for an empty polyline", () => {
  assert.equal(polylineBounds([]), null);
});

test("polylineBounds covers every point", () => {
  const points: Point[] = [
    { x: 10, y: 50 },
    { x: 10, y: -20 },
    { x: 90, y: -20 },
  ];
  assert.deepEqual(polylineBounds(points), {
    minX: 10,
    minY: -20,
    maxX: 90,
    maxY: 50,
  });
});

test("polylineBounds inflates by the requested margin", () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 40 },
  ];
  assert.deepEqual(polylineBounds(points, 25), {
    minX: -25,
    minY: -25,
    maxX: 125,
    maxY: 65,
  });
});

test("polylineBounds of a single point is a margin-sized window", () => {
  assert.deepEqual(polylineBounds([{ x: 5, y: 5 }], 10), {
    minX: -5,
    minY: -5,
    maxX: 15,
    maxY: 15,
  });
});

// ---------------------------------------------------------------------------
// ObstacleIndex
// ---------------------------------------------------------------------------

test("an empty index answers every query with no obstacles", () => {
  const index = new ObstacleIndex([]);
  assert.equal(index.size, 0);
  assert.deepEqual(
    index.query({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 }),
    []
  );
});

test("query returns only obstacles intersecting the window", () => {
  const near = box(100, 0, 40, 40);
  const far = box(5000, 5000, 40, 40);
  const index = new ObstacleIndex([
    obstacleEntry("near", near),
    obstacleEntry("far", far),
  ]);

  assert.equal(index.size, 2);
  const hits = index.query({ minX: 0, minY: -50, maxX: 300, maxY: 50 });
  assert.deepEqual(hits, [near]);
});

test("query includes boxes that merely touch the window edge", () => {
  const touching = box(100, 0, 40, 40);
  const index = new ObstacleIndex([obstacleEntry("t", touching)]);

  const hits = index.query({ minX: 0, minY: 0, maxX: 100, maxY: 40 });
  assert.deepEqual(hits, [touching]);
});

test("query excludes the two owner ids it is given", () => {
  const source = box(0, 0, 40, 40);
  const target = box(200, 0, 40, 40);
  const between = box(100, 0, 40, 40);
  const index = new ObstacleIndex([
    obstacleEntry("source", source),
    obstacleEntry("between", between),
    obstacleEntry("target", target),
  ]);

  const window = { minX: -100, minY: -100, maxX: 400, maxY: 100 };
  assert.deepEqual(sortBoxes(index.query(window)), [source, between, target]);
  assert.deepEqual(index.query(window, "source", "target"), [between]);
});

test("all boxes owned by an excluded node are dropped (body plus label)", () => {
  // A node contributes both its body box and its label box under one owner id;
  // excluding the owner must drop both, or an edge would route around its own
  // endpoint's label.
  const body = box(0, 0, 120, 60);
  const label = box(8, 6, 60, 16);
  const other = box(300, 0, 40, 40);
  const index = new ObstacleIndex([
    obstacleEntry("a", body),
    obstacleEntry("a", label),
    obstacleEntry("b", other),
  ]);

  assert.equal(index.size, 3);
  assert.deepEqual(index.query({ minX: -50, minY: -50, maxX: 500, maxY: 100 }, "a"), [
    other,
  ]);
});

test("queryForPolyline finds obstacles along the routed path only", () => {
  const onPath = box(100, 10, 40, 20);
  const wayOff = box(100, 900, 40, 20);
  const index = new ObstacleIndex([
    obstacleEntry("on", onPath),
    obstacleEntry("off", wayOff),
  ]);

  const hits = index.queryForPolyline(
    [
      { x: 0, y: 20 },
      { x: 300, y: 20 },
    ],
    16
  );
  assert.deepEqual(hits, [onPath]);
});

test("queryForPolyline margin widens the corridor", () => {
  const nearby = box(100, 60, 40, 20);
  const index = new ObstacleIndex([obstacleEntry("n", nearby)]);
  const path: Point[] = [
    { x: 0, y: 20 },
    { x: 300, y: 20 },
  ];

  assert.deepEqual(index.queryForPolyline(path, 10), []);
  assert.deepEqual(index.queryForPolyline(path, 100), [nearby]);
});

test("queryForPolyline returns nothing for a degenerate polyline", () => {
  const index = new ObstacleIndex([obstacleEntry("n", box(0, 0, 10, 10))]);
  assert.deepEqual(index.queryForPolyline([], 50), []);
});

test("querying is bounded by locality, not by index size", () => {
  // 4000 obstacles laid out in a wide row; a short edge must only ever see the
  // handful of boxes near it. This is the property the O(E x N) scan lacked.
  const entries = Array.from({ length: 4000 }, (_, i) =>
    obstacleEntry(`n-${i}`, box(i * 100, 0, 40, 40))
  );
  const index = new ObstacleIndex(entries);

  const hits = index.queryForPolyline(
    [
      { x: 0, y: 20 },
      { x: 250, y: 20 },
    ],
    20
  );
  assert.ok(hits.length <= 4, `expected a handful of hits, got ${hits.length}`);
  assert.ok(hits.length >= 1, "expected the boxes on the path");
});
