import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NODE_EMPHASIS_STYLES,
  edgeEndpointIds,
  emphasisRedrawIds,
  nodeBorderStyle,
  resolveNodeEmphasis,
  type NodeEmphasis,
} from "../src/canvas/renderers/nodeEmphasis.ts";

describe("node emphasis precedence", () => {
  it("selection outranks being a hovered edge's endpoint", () => {
    // A selected node keeps its selected border while an edge touching it is
    // hovered -- the pin must not visually downgrade.
    assert.equal(resolveNodeEmphasis(true, true), "selected");
    assert.equal(resolveNodeEmphasis(true, false), "selected");
  });

  it("an unselected endpoint of the hovered edge is emphasised", () => {
    assert.equal(resolveNodeEmphasis(false, true), "edge-endpoint");
  });

  it("everything else is unemphasised", () => {
    assert.equal(resolveNodeEmphasis(false, false), "none");
  });
});

describe("node border styles", () => {
  it("every emphasis level has a style", () => {
    for (const level of ["none", "edge-endpoint", "selected"] as NodeEmphasis[]) {
      const style = nodeBorderStyle(level);
      assert.equal(style, NODE_EMPHASIS_STYLES[level]);
      assert.ok(Number.isInteger(style.color));
      assert.ok(style.width > 0);
    }
  });

  it("emphasis reads as strictly increasing border weight", () => {
    // The visual hierarchy is the whole point: an endpoint must be more
    // prominent than a plain node and less prominent than the selection.
    assert.ok(
      NODE_EMPHASIS_STYLES.none.width <
        NODE_EMPHASIS_STYLES["edge-endpoint"].width &&
        NODE_EMPHASIS_STYLES["edge-endpoint"].width <
          NODE_EMPHASIS_STYLES.selected.width
    );
  });

  it("each level is visually distinct", () => {
    const colors = new Set(
      Object.values(NODE_EMPHASIS_STYLES).map((s) => s.color)
    );
    assert.equal(colors.size, 3);
  });
});

describe("hovered-edge endpoint ids", () => {
  it("collects both endpoints of the hovered edge", () => {
    assert.deepEqual([...edgeEndpointIds("fileA", "fileB")].sort(), ["fileA", "fileB"]);
  });

  it("a self-loop yields a single id", () => {
    assert.deepEqual([...edgeEndpointIds("fileA", "fileA")], ["fileA"]);
  });

  it("no hovered edge yields an empty set", () => {
    assert.equal(edgeEndpointIds(null, null).size, 0);
    assert.equal(edgeEndpointIds("fileA", null).size, 0);
    assert.equal(edgeEndpointIds(null, "fileB").size, 0);
  });
});

describe("emphasis redraw diffing", () => {
  const set = (...ids: string[]) => new Set(ids);

  it("redraws only the nodes whose endpoint-ness changed", () => {
    // b is an endpoint before and after, so it must not be redrawn.
    assert.deepEqual(
      emphasisRedrawIds(set("a", "b"), set("b", "c")).sort(),
      ["a", "c"]
    );
  });

  it("entering a hover redraws the new endpoints", () => {
    assert.deepEqual(emphasisRedrawIds(set(), set("a", "b")).sort(), ["a", "b"]);
  });

  it("leaving a hover redraws the old endpoints", () => {
    assert.deepEqual(emphasisRedrawIds(set("a", "b"), set()).sort(), ["a", "b"]);
  });

  it("an unchanged set redraws nothing", () => {
    assert.deepEqual(emphasisRedrawIds(set("a", "b"), set("a", "b")), []);
    assert.deepEqual(emphasisRedrawIds(set(), set()), []);
  });
});
