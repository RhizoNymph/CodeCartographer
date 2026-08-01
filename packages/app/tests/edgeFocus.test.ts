import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeGraph, EdgeKind, EdgeDetail, Neighborhood } from "../src/api/types.ts";
import {
  reduceSetViewModeFrame,
  reduceEnterNodeFocus,
  reduceEnterEdgeFocus,
  reduceExitFocusFrame,
  focusedNodeId,
  focusHasDepth,
  focusBreadcrumbModel,
  focusLayoutIds,
  focusVisibleNodes,
  focusExpandedNodes,
  type FocusFrame,
  type FocusFrameState,
} from "../src/stores/graphViewModel.ts";

// root -> [fileA, fileB]; fileA -> [fnA1, fnA2]; fileB -> [fnB1]
const graph: CodeGraph = {
  root: "root",
  edgeCount: 3,
  nodeEdgeKinds: new Map<string, EdgeKind[]>(),
  nodes: {
    root: { type: "Directory", id: "root", name: "repo", path: "", children: ["fileA", "fileB"] },
    fileA: {
      type: "File",
      id: "fileA",
      name: "fileA.py",
      path: "fileA.py",
      language: "Python",
      children: ["fnA1", "fnA2"],
    },
    fileB: {
      type: "File",
      id: "fileB",
      name: "fileB.py",
      path: "fileB.py",
      language: "Python",
      children: ["fnB1"],
    },
    fnA1: {
      type: "CodeBlock",
      id: "fnA1",
      name: "fnA1",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 0 },
      signature: null,
      visibility: null,
      parent: "fileA",
      children: [],
    },
    fnA2: {
      type: "CodeBlock",
      id: "fnA2",
      name: "fnA2",
      kind: "Function",
      span: { start_line: 3, start_col: 0, end_line: 4, end_col: 0 },
      signature: null,
      visibility: null,
      parent: "fileA",
      children: [],
    },
    fnB1: {
      type: "CodeBlock",
      id: "fnB1",
      name: "fnB1",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 0 },
      signature: null,
      visibility: null,
      parent: "fileB",
      children: [],
    },
  },
};

const unfocused: FocusFrameState = { viewMode: "module", frame: null };

const nodeFrame: FocusFrame = { type: "node", nodeId: "fileA", depth: 2 };
const edgeFrame: FocusFrame = { type: "edge", source: "fileA", target: "fileB" };

/** What `get_edge_detail` returns for the fileA -> fileB aggregate. */
const edgeDetail: EdgeDetail = {
  source: "fileA",
  target: "fileB",
  node_ids: ["fileA", "fileB", "fnA1", "fnA2", "fnB1", "root"],
  edges: [
    { source: "fnA1", target: "fnB1", kind: "FunctionCall", weight: 1, resolution: "SameFile" },
    { source: "fnA2", target: "fnB1", kind: "FunctionCall", weight: 1, resolution: "SameFile" },
  ],
};

const neighborhood: Neighborhood = {
  focus: "fileA",
  depth: 1,
  node_ids: ["fileA", "fnA1", "root"],
  edges: [],
};

describe("focus frame reducers", () => {
  it("entering an edge focus forces symbol view and records the pair", () => {
    const next = reduceEnterEdgeFocus(unfocused, "fileA", "fileB");
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.frame, { type: "edge", source: "fileA", target: "fileB" });
  });

  it("entering a node focus forces symbol view and records node + depth", () => {
    const next = reduceEnterNodeFocus(unfocused, "fileA", 2);
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.frame, { type: "node", nodeId: "fileA", depth: 2 });
  });

  it("an edge focus replaces an active node focus (and vice versa)", () => {
    const fromNode = reduceEnterEdgeFocus({ viewMode: "symbol", frame: nodeFrame }, "fileA", "fileB");
    assert.deepEqual(fromNode.frame, edgeFrame);

    const fromEdge = reduceEnterNodeFocus({ viewMode: "symbol", frame: edgeFrame }, "fnB1", 1);
    assert.deepEqual(fromEdge.frame, { type: "node", nodeId: "fnB1", depth: 1 });
  });

  it("switching to module view drops any focus frame", () => {
    for (const frame of [nodeFrame, edgeFrame]) {
      const next = reduceSetViewModeFrame({ viewMode: "symbol", frame }, "module");
      assert.equal(next.viewMode, "module");
      assert.equal(next.frame, null);
    }
  });

  it("switching to symbol view preserves the focus frame", () => {
    const next = reduceSetViewModeFrame({ viewMode: "symbol", frame: edgeFrame }, "symbol");
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.frame, edgeFrame);
  });

  it("exiting focus clears the frame but keeps symbol view", () => {
    const next = reduceExitFocusFrame({ viewMode: "symbol", frame: edgeFrame });
    assert.equal(next.frame, null);
    assert.equal(next.viewMode, "symbol");
  });

  it("frame reducers are pure (do not mutate their input)", () => {
    const input: FocusFrameState = { viewMode: "symbol", frame: nodeFrame };
    reduceSetViewModeFrame(input, "module");
    reduceExitFocusFrame(input);
    reduceEnterEdgeFocus(input, "fileA", "fileB");
    assert.equal(input.viewMode, "symbol");
    assert.deepEqual(input.frame, { type: "node", nodeId: "fileA", depth: 2 });
  });
});

describe("focus frame accessors", () => {
  it("only a node frame has a focused node id", () => {
    assert.equal(focusedNodeId(nodeFrame), "fileA");
    assert.equal(focusedNodeId(edgeFrame), null);
    assert.equal(focusedNodeId(null), null);
  });

  it("depth applies to node focus only, so the selector hides on edge focus", () => {
    assert.equal(focusHasDepth(nodeFrame), true);
    assert.equal(focusHasDepth(edgeFrame), false);
    assert.equal(focusHasDepth(null), false);
  });
});

describe("focus breadcrumb model", () => {
  it("a node frame reads as the node's name plus its depth", () => {
    assert.deepEqual(focusBreadcrumbModel(graph, nodeFrame), {
      type: "node",
      label: "fileA.py",
      depth: 2,
    });
  });

  it("an edge frame reads as source -> target names", () => {
    assert.deepEqual(focusBreadcrumbModel(graph, edgeFrame), {
      type: "edge",
      sourceLabel: "fileA.py",
      targetLabel: "fileB.py",
    });
  });

  it("falls back to raw ids for nodes missing from the graph", () => {
    assert.deepEqual(focusBreadcrumbModel(graph, { type: "edge", source: "ghost", target: "fileB" }), {
      type: "edge",
      sourceLabel: "ghost",
      targetLabel: "fileB.py",
    });
    assert.deepEqual(focusBreadcrumbModel(graph, { type: "node", nodeId: "ghost", depth: 1 }), {
      type: "node",
      label: "ghost",
      depth: 1,
    });
  });

  it("is null with no frame or no graph", () => {
    assert.equal(focusBreadcrumbModel(graph, null), null);
    assert.equal(focusBreadcrumbModel(null, edgeFrame), null);
  });
});

describe("focus layout ids", () => {
  it("an edge frame lays out exactly the edge-detail ids", () => {
    assert.deepEqual(
      focusLayoutIds(edgeFrame, null, edgeDetail),
      ["fileA", "fileB", "fnA1", "fnA2", "fnB1", "root"]
    );
  });

  it("a node frame lays out the neighborhood ids", () => {
    assert.deepEqual(focusLayoutIds(nodeFrame, neighborhood, null), ["fileA", "fnA1", "root"]);
  });

  it("each frame type ignores the other's payload", () => {
    assert.equal(focusLayoutIds(edgeFrame, neighborhood, null), null);
    assert.equal(focusLayoutIds(nodeFrame, null, edgeDetail), null);
  });

  it("is null while unfocused, so the canvas keeps its normal derivation", () => {
    assert.equal(focusLayoutIds(null, neighborhood, edgeDetail), null);
  });
});

describe("edge-focus layout sets", () => {
  it("visible set is exactly the edge-detail ids present in the graph", () => {
    const ids = focusLayoutIds(edgeFrame, null, edgeDetail)!;
    const visible = focusVisibleNodes(graph, ids);
    assert.deepEqual(
      [...visible].sort(),
      ["fileA", "fileB", "fnA1", "fnA2", "fnB1", "root"]
    );
  });

  it("containers of the contributing symbols are expanded, blocks are not", () => {
    const ids = focusLayoutIds(edgeFrame, null, edgeDetail)!;
    const expanded = focusExpandedNodes(graph, ids);
    assert.deepEqual([...expanded].sort(), ["fileA", "fileB", "root"]);
  });

  it("unknown ids in the payload are dropped rather than laid out", () => {
    const withGhost = { ...edgeDetail, node_ids: [...edgeDetail.node_ids, "ghost"] };
    const ids = focusLayoutIds(edgeFrame, null, withGhost)!;
    assert.ok(!focusVisibleNodes(graph, ids).has("ghost"));
  });
});
