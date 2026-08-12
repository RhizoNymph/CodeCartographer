import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyLayoutWork,
  layoutWorkFor,
  marksLayoutStale,
  type GraphChange,
  type LayoutContext,
  type LayoutTriggers,
} from "../src/stores/relayoutPolicy.ts";

const symbolView: LayoutContext = {
  viewMode: "symbol",
  focusActive: false,
  hideUnconnectedNodes: false,
};

const moduleView: LayoutContext = {
  viewMode: "module",
  focusActive: false,
  hideUnconnectedNodes: false,
};

const focused: LayoutContext = {
  viewMode: "symbol",
  focusActive: true,
  hideUnconnectedNodes: false,
};

function work(change: GraphChange, ctx: LayoutContext = symbolView) {
  return layoutWorkFor(change, ctx);
}

describe("layoutWorkFor: changes that always need node positions", () => {
  it("a fresh graph needs a full layout", () => {
    assert.equal(work({ kind: "graph-replaced" }), "full");
    assert.equal(work({ kind: "graph-replaced" }, moduleView), "full");
  });

  it("a view-mode switch needs a full layout", () => {
    assert.equal(work({ kind: "view-mode" }), "full");
    assert.equal(work({ kind: "view-mode" }, focused), "full");
  });

  it("entering/leaving/updating focus needs a full layout", () => {
    assert.equal(work({ kind: "focus" }), "full");
    assert.equal(work({ kind: "focus" }, focused), "full");
  });

  it("the explicit Apply Layout Changes button always forces a full layout", () => {
    assert.equal(work({ kind: "relayout-requested" }), "full");
    assert.equal(work({ kind: "relayout-requested" }, moduleView), "full");
    assert.equal(work({ kind: "relayout-requested" }, focused), "full");
  });
});

describe("layoutWorkFor: expansion", () => {
  it("expanding anything in symbol view changes the node set", () => {
    assert.equal(work({ kind: "expansion", nodeType: "Directory" }), "full");
    assert.equal(work({ kind: "expansion", nodeType: "File" }), "full");
    assert.equal(work({ kind: "expansion", nodeType: "CodeBlock" }), "full");
  });

  it("module view ignores File expansion, so it needs no layout at all", () => {
    assert.equal(work({ kind: "expansion", nodeType: "File" }, moduleView), "none");
    assert.equal(work({ kind: "expansion", nodeType: "CodeBlock" }, moduleView), "none");
  });

  it("module view still lays out Directory expansion", () => {
    assert.equal(work({ kind: "expansion", nodeType: "Directory" }, moduleView), "full");
  });

  it("focus derives expansion from the frame payload, so toggles are inert", () => {
    assert.equal(work({ kind: "expansion", nodeType: "Directory" }, focused), "none");
    assert.equal(work({ kind: "expansion", nodeType: "File" }, focused), "none");
  });

  it("an unknown node type is treated conservatively", () => {
    assert.equal(work({ kind: "expansion", nodeType: null }, moduleView), "full");
  });
});

describe("layoutWorkFor: visibility", () => {
  it("hiding nodes uses the cheap visibility path", () => {
    assert.equal(work({ kind: "visibility", showing: false }), "visibility");
    assert.equal(work({ kind: "visibility", showing: false }, moduleView), "visibility");
  });

  it("showing nodes needs positions for nodes that were never laid out", () => {
    assert.equal(work({ kind: "visibility", showing: true }), "full");
  });

  it("focus overrides the visible set, so toggles are inert", () => {
    assert.equal(work({ kind: "visibility", showing: true }, focused), "none");
    assert.equal(work({ kind: "visibility", showing: false }, focused), "none");
  });
});

describe("layoutWorkFor: edge-only changes", () => {
  it("an edge-kind toggle only re-runs the edge phase", () => {
    assert.equal(work({ kind: "edge-kinds" }), "edges");
    assert.equal(work({ kind: "edge-kinds" }, focused), "edges");
  });

  it("module view forces {Import}, so edge-kind toggles do nothing", () => {
    assert.equal(work({ kind: "edge-kinds" }, moduleView), "none");
  });

  it("hide-unconnected makes the node set depend on edge kinds, forcing a full layout", () => {
    assert.equal(
      work({ kind: "edge-kinds" }, { ...symbolView, hideUnconnectedNodes: true }),
      "full"
    );
  });

  it("a focused view is not filtered by hide-unconnected, so edges suffice", () => {
    assert.equal(
      work({ kind: "edge-kinds" }, { ...focused, hideUnconnectedNodes: true }),
      "edges"
    );
  });

  it("hide-ambiguous is a pure client-side edge filter", () => {
    assert.equal(work({ kind: "hide-ambiguous" }), "edges");
    assert.equal(
      work({ kind: "hide-ambiguous" }, { ...symbolView, hideUnconnectedNodes: true }),
      "edges"
    );
  });

  it("module view has no ambiguous edges to hide", () => {
    assert.equal(work({ kind: "hide-ambiguous" }, moduleView), "none");
  });
});

describe("layoutWorkFor: hide-unconnected", () => {
  it("changes the node set", () => {
    assert.equal(work({ kind: "hide-unconnected" }), "full");
  });

  it("is inert while focused", () => {
    assert.equal(work({ kind: "hide-unconnected" }, focused), "none");
  });
});

describe("applyLayoutWork", () => {
  const base: LayoutTriggers = {
    layoutVersion: 3,
    edgeVersion: 7,
    needsRelayout: true,
  };

  it("a full layout bumps layoutVersion once and clears the stale flag", () => {
    assert.deepEqual(applyLayoutWork("full", base), {
      layoutVersion: 4,
      edgeVersion: 7,
      needsRelayout: false,
    });
  });

  it("an edge phase bumps only edgeVersion and marks positions stale", () => {
    assert.deepEqual(applyLayoutWork("edges", { ...base, needsRelayout: false }), {
      layoutVersion: 3,
      edgeVersion: 8,
      needsRelayout: true,
    });
  });

  it("a visibility change bumps nothing but marks positions stale", () => {
    assert.deepEqual(applyLayoutWork("visibility", { ...base, needsRelayout: false }), {
      layoutVersion: 3,
      edgeVersion: 7,
      needsRelayout: true,
    });
  });

  it("no work leaves the triggers untouched", () => {
    assert.equal(applyLayoutWork("none", base), base);
  });

  it("one action never bumps both versions", () => {
    for (const w of ["full", "edges", "visibility", "none"] as const) {
      const next = applyLayoutWork(w, base);
      const bumps =
        (next.layoutVersion === base.layoutVersion ? 0 : 1) +
        (next.edgeVersion === base.edgeVersion ? 0 : 1);
      assert.ok(bumps <= 1, `${w} bumped ${bumps} versions`);
    }
  });
});

describe("marksLayoutStale", () => {
  it("is true exactly for the work that skipped positions", () => {
    assert.equal(marksLayoutStale("edges"), true);
    assert.equal(marksLayoutStale("visibility"), true);
    assert.equal(marksLayoutStale("full"), false);
    assert.equal(marksLayoutStale("none"), false);
  });
});
