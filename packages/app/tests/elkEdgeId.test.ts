import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { elkEdgeId, elkEdgeIndex } from "../src/canvas/layout/elkEdgeId.ts";

describe("elk edge id round-trip", () => {
  it("round-trips indexes through the id", () => {
    for (const index of [0, 1, 7, 42, 1499]) {
      assert.equal(elkEdgeIndex(elkEdgeId(index)), index);
    }
  });

  it("keeps parallel same-pair edges distinguishable", () => {
    // Two edges between the same node pair get different ids -- the whole
    // point of index-encoding over a source->target pair key.
    assert.notEqual(elkEdgeId(0), elkEdgeId(1));
  });

  it("returns null for ids it did not produce", () => {
    for (const id of ["", "edge-", "edge-x", "edge--1", "e-1", "edge-1.5", "xedge-1", "edge-1x"]) {
      assert.equal(elkEdgeIndex(id), null, JSON.stringify(id));
    }
  });
});
