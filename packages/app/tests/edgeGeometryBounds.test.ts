import assert from "node:assert/strict";
import test from "node:test";

import { boundingBox, type NodeBox } from "../src/canvas/layout/edgeGeometry.ts";

test("boundingBox of a single box is that box", () => {
  const box: NodeBox = { x: 10, y: 20, width: 30, height: 40 };
  assert.deepEqual(boundingBox([box]), box);
});

test("boundingBox spans every box, including negative coordinates", () => {
  assert.deepEqual(
    boundingBox([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: -50, y: 5, width: 10, height: 10 },
      { x: 100, y: -30, width: 20, height: 5 },
    ]),
    { x: -50, y: -30, width: 170, height: 45 }
  );
});

test("boundingBox ignores boxes fully contained in another", () => {
  assert.deepEqual(
    boundingBox([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 20, y: 20, width: 10, height: 10 },
    ]),
    { x: 0, y: 0, width: 100, height: 100 }
  );
});

test("boundingBox of no boxes is an empty box at the origin", () => {
  assert.deepEqual(boundingBox([]), { x: 0, y: 0, width: 0, height: 0 });
});

test("boundingBox handles ten thousand boxes without a spread-argument overflow", () => {
  // Math.min(...boxes.map(...)) blows the call stack around this size; the
  // loop-based implementation must not.
  const boxes: NodeBox[] = Array.from({ length: 10000 }, (_, i) => ({
    x: i,
    y: -i,
    width: 2,
    height: 3,
  }));

  assert.deepEqual(boundingBox(boxes), {
    x: 0,
    y: -9999,
    width: 10001,
    height: 10002,
  });
});
