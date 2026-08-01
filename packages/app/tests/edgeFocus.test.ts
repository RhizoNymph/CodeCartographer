import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeGraph, EdgeKind, EdgeDetail, Neighborhood } from "../src/api/types.ts";
import {
  reduceSetViewMode,
  reduceEnterFocus,
  reduceExitFocus,
  focusTopFrame,
  focusTopNodeId,
  focusFrameLabel,
  focusLayoutIds,
  focusVisibleNodes,
  focusExpandedNodes,
  type FocusFrame,
  type FocusViewState,
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

const unfocused: FocusViewState = { viewMode: "module", focusStack: [] };

const nodeFrame: FocusFrame = { type: "node", nodeId: "fileA", depth: 2, direction: "both" };
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
  direction: "both",
  node_ids: ["fileA", "fnA1", "root"],
  edges: [],
};

describe("edge frames on the focus stack", () => {
  it("entering an edge focus forces symbol view and pushes the pair", () => {
    const next = reduceEnterFocus(unfocused, edgeFrame);
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.focusStack, [edgeFrame]);
  });

  it("an edge focus from inside a node focus pushes a deeper frame", () => {
    const next = reduceEnterFocus({ viewMode: "symbol", focusStack: [nodeFrame] }, edgeFrame);
    assert.deepEqual(next.focusStack, [nodeFrame, edgeFrame]);
  });

  it("re-entering the same edge pair replaces the top frame, not stacking a duplicate", () => {
    const focused: FocusViewState = { viewMode: "symbol", focusStack: [nodeFrame, edgeFrame] };
    const next = reduceEnterFocus(focused, { type: "edge", source: "fileA", target: "fileB" });
    assert.equal(next.focusStack.length, 2);
    assert.deepEqual(focusTopFrame(next.focusStack), edgeFrame);
  });

  it("switching to module view drops the whole stack, edge frames included", () => {
    const next = reduceSetViewMode(
      { viewMode: "symbol", focusStack: [nodeFrame, edgeFrame] },
      "module"
    );
    assert.equal(next.viewMode, "module");
    assert.deepEqual(next.focusStack, []);
  });

  it("switching to symbol view preserves the stack", () => {
    const next = reduceSetViewMode({ viewMode: "symbol", focusStack: [edgeFrame] }, "symbol");
    assert.deepEqual(next.focusStack, [edgeFrame]);
  });

  it("exiting focus clears the stack but keeps symbol view", () => {
    const next = reduceExitFocus({ viewMode: "symbol", focusStack: [nodeFrame, edgeFrame] });
    assert.deepEqual(next.focusStack, []);
    assert.equal(next.viewMode, "symbol");
  });

  it("reducers are pure (do not mutate their input)", () => {
    const input: FocusViewState = { viewMode: "symbol", focusStack: [nodeFrame] };
    reduceSetViewMode(input, "module");
    reduceExitFocus(input);
    reduceEnterFocus(input, edgeFrame);
    assert.equal(input.viewMode, "symbol");
    assert.deepEqual(input.focusStack, [nodeFrame]);
  });
});

describe("edge frame accessors", () => {
  it("only a node top frame has a focused node id", () => {
    assert.equal(focusTopNodeId([nodeFrame]), "fileA");
    assert.equal(focusTopNodeId([edgeFrame]), null);
    assert.equal(focusTopNodeId([edgeFrame, nodeFrame]), "fileA");
    assert.equal(focusTopNodeId([]), null);
  });

  it("an edge frame labels as source -> target names", () => {
    const nameOf = (id: string) => graph.nodes[id]?.name ?? id;
    assert.equal(focusFrameLabel(edgeFrame, nameOf), "fileA.py → fileB.py");
    assert.equal(focusFrameLabel(nodeFrame, nameOf), "fileA.py");
  });

  it("labels fall back to raw ids for nodes missing from the graph", () => {
    const nameOf = (id: string) => graph.nodes[id]?.name ?? id;
    assert.equal(
      focusFrameLabel({ type: "edge", source: "ghost", target: "fileB" }, nameOf),
      "ghost → fileB.py"
    );
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
