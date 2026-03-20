import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorEdgePolyline,
  rerouteOrthogonalEdge,
  type EdgeAnchor,
  type EdgeAnchorSide,
  type NodeBox,
  type Point,
} from "../src/canvas/layout/edgeGeometry.ts";

const sourceBox: NodeBox = {
  x: 0,
  y: 0,
  width: 40,
  height: 40,
};

const targetBox: NodeBox = {
  x: 200,
  y: 0,
  width: 40,
  height: 40,
};

function anchor(side: EdgeAnchorSide): EdgeAnchor {
  return { side, offset: 20 };
}

function assertLeavesFromSide(points: Point[], side: EdgeAnchorSide) {
  assert.ok(points.length >= 2);
  const start = points[0];
  const next = points[1];

  switch (side) {
    case "left":
      assert.strictEqual(next.y, start.y);
      assert.ok(next.x < start.x);
      break;
    case "right":
      assert.strictEqual(next.y, start.y);
      assert.ok(next.x > start.x);
      break;
    case "top":
      assert.strictEqual(next.x, start.x);
      assert.ok(next.y < start.y);
      break;
    case "bottom":
      assert.strictEqual(next.x, start.x);
      assert.ok(next.y > start.y);
      break;
  }
}

function assertApproachesFromSide(points: Point[], side: EdgeAnchorSide) {
  assert.ok(points.length >= 2);
  const end = points[points.length - 1];
  const prev = points[points.length - 2];

  switch (side) {
    case "left":
      assert.strictEqual(prev.y, end.y);
      assert.ok(prev.x < end.x);
      break;
    case "right":
      assert.strictEqual(prev.y, end.y);
      assert.ok(prev.x > end.x);
      break;
    case "top":
      assert.strictEqual(prev.x, end.x);
      assert.ok(prev.y < end.y);
      break;
    case "bottom":
      assert.strictEqual(prev.x, end.x);
      assert.ok(prev.y > end.y);
      break;
  }
}

test("rerouteOrthogonalEdge detours same-side horizontal anchors on the same row", () => {
  const points = rerouteOrthogonalEdge(
    [
      { x: 0, y: 20 },
      { x: 240, y: 20 },
    ],
    sourceBox,
    targetBox,
    anchor("left"),
    anchor("left")
  );

  assertLeavesFromSide(points, "left");
  assertApproachesFromSide(points, "left");
  assert.ok(points.some((point) => point.y !== 20));
});

test("rerouteOrthogonalEdge detours same-side vertical anchors on the same column", () => {
  const bottomBox: NodeBox = { x: 0, y: 200, width: 40, height: 40 };
  const points = rerouteOrthogonalEdge(
    [
      { x: 20, y: 0 },
      { x: 20, y: 240 },
    ],
    sourceBox,
    bottomBox,
    anchor("top"),
    anchor("top")
  );

  assertLeavesFromSide(points, "top");
  assertApproachesFromSide(points, "top");
  assert.ok(points.some((point) => point.x !== 20));
});

test("anchorEdgePolyline reroutes when endpoint anchoring would approach from the wrong side", () => {
  const points = anchorEdgePolyline(
    [
      { x: 0, y: 20 },
      { x: -80, y: 20 },
      { x: 240, y: 20 },
    ],
    sourceBox,
    targetBox,
    anchor("left"),
    anchor("left")
  );

  assertLeavesFromSide(points, "left");
  assertApproachesFromSide(points, "left");
  assert.ok(points.some((point) => point.y !== 20));
});
