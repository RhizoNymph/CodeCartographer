import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorEdgePolyline,
  getAnchorPoint,
  inferEdgeAnchor,
  inferEdgeAnchorFromPoint,
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

test("inferEdgeAnchor prefers top or bottom for vertical approaches at a side boundary", () => {
  const box: NodeBox = { x: 100, y: 100, width: 80, height: 40 };

  const fromAbove = inferEdgeAnchor(
    box,
    { x: 100, y: 120 },
    { x: 100, y: 40 }
  );
  assert.equal(fromAbove.side, "top");
  assert.deepEqual(getAnchorPoint(box, fromAbove), { x: 100, y: 100 });

  const fromBelow = inferEdgeAnchor(
    box,
    { x: 100, y: 120 },
    { x: 100, y: 180 }
  );
  assert.equal(fromBelow.side, "bottom");
  assert.deepEqual(getAnchorPoint(box, fromBelow), { x: 100, y: 140 });
});

test("inferEdgeAnchor keeps side anchors for horizontal approaches", () => {
  const box: NodeBox = { x: 100, y: 100, width: 80, height: 40 };

  const fromLeft = inferEdgeAnchor(
    box,
    { x: 100, y: 120 },
    { x: 40, y: 120 }
  );
  assert.equal(fromLeft.side, "left");
  assert.deepEqual(getAnchorPoint(box, fromLeft), { x: 100, y: 120 });

  const fromRight = inferEdgeAnchor(
    box,
    { x: 180, y: 120 },
    { x: 240, y: 120 }
  );
  assert.equal(fromRight.side, "right");
  assert.deepEqual(getAnchorPoint(box, fromRight), { x: 180, y: 120 });
});

test("inferEdgeAnchorFromPoint chooses vertical anchors when another node is above or below", () => {
  const box: NodeBox = { x: 100, y: 100, width: 80, height: 40 };

  const towardAbove = inferEdgeAnchorFromPoint(box, { x: 140, y: 20 });
  assert.equal(towardAbove.side, "top");
  assert.deepEqual(getAnchorPoint(box, towardAbove), { x: 140, y: 100 });

  const towardBelow = inferEdgeAnchorFromPoint(box, { x: 140, y: 220 });
  assert.equal(towardBelow.side, "bottom");
  assert.deepEqual(getAnchorPoint(box, towardBelow), { x: 140, y: 140 });
});

test("rerouteOrthogonalEdge uses dynamically inferred vertical anchors for moved nodes", () => {
  const upperBox: NodeBox = { x: 100, y: 100, width: 80, height: 40 };
  const lowerBox: NodeBox = { x: 100, y: 280, width: 80, height: 40 };
  const upperCenter = {
    x: upperBox.x + upperBox.width / 2,
    y: upperBox.y + upperBox.height / 2,
  };
  const lowerCenter = {
    x: lowerBox.x + lowerBox.width / 2,
    y: lowerBox.y + lowerBox.height / 2,
  };
  const sourceAnchor = inferEdgeAnchorFromPoint(upperBox, lowerCenter);
  const targetAnchor = inferEdgeAnchorFromPoint(lowerBox, upperCenter);

  const points = rerouteOrthogonalEdge(
    [
      { x: 180, y: 120 },
      { x: 260, y: 120 },
      { x: 260, y: 300 },
      { x: 180, y: 300 },
    ],
    upperBox,
    lowerBox,
    sourceAnchor,
    targetAnchor
  );

  assertLeavesFromSide(points, "bottom");
  assertApproachesFromSide(points, "top");
});
