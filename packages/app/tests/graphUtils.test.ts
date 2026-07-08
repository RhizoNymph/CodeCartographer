import assert from "node:assert/strict";
import test from "node:test";

import { isAncestorOf } from "../src/canvas/utils/graphUtils.ts";

test("isAncestorOf detects direct and nested parent relationships", () => {
  const parentMap = new Map([
    ["file", "root"],
    ["visibleFn", "file"],
    ["hiddenFn", "file"],
    ["innerFn", "visibleFn"],
  ]);

  assert.equal(isAncestorOf("file", "visibleFn", parentMap), true);
  assert.equal(isAncestorOf("file", "innerFn", parentMap), true);
  assert.equal(isAncestorOf("root", "innerFn", parentMap), true);
  assert.equal(isAncestorOf("visibleFn", "file", parentMap), false);
  assert.equal(isAncestorOf("hiddenFn", "visibleFn", parentMap), false);
});
