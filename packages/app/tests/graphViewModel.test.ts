import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeGraph, EdgeKind } from "../src/api/types.ts";
import { createGraphViewModel } from "../src/canvas/view/graphViewModel.ts";

const graph: CodeGraph = {
  root: "root",
  nodes: {
    root: {
      type: "Directory",
      id: "root",
      name: "repo",
      path: "",
      children: ["src", "docs"],
    },
    src: {
      type: "Directory",
      id: "src",
      name: "src",
      path: "src",
      children: ["main.ts", "util.ts"],
    },
    docs: {
      type: "Directory",
      id: "docs",
      name: "docs",
      path: "docs",
      children: [],
    },
    "main.ts": {
      type: "File",
      id: "main.ts",
      name: "main.ts",
      path: "src/main.ts",
      language: "TypeScript",
      children: ["main"],
    },
    "util.ts": {
      type: "File",
      id: "util.ts",
      name: "util.ts",
      path: "src/util.ts",
      language: "TypeScript",
      children: ["helper"],
    },
    main: {
      type: "CodeBlock",
      id: "main",
      name: "main",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 3, end_col: 1 },
      signature: "function main()",
      visibility: "Public",
      parent: "main.ts",
      children: [],
    },
    helper: {
      type: "CodeBlock",
      id: "helper",
      name: "helper",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 3, end_col: 1 },
      signature: "function helper()",
      visibility: "Public",
      parent: "util.ts",
      children: [],
    },
  },
  edges: [
    { source: "main", target: "helper", kind: "FunctionCall", weight: 1 },
  ],
};

const allEdgeKinds = new Set<EdgeKind>([
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
]);

describe("createGraphViewModel", () => {
  it("copies mutable store sets before returning them", () => {
    const expandedNodes = new Set(["root"]);
    const visibleNodes = new Set(Object.keys(graph.nodes));
    const model = createGraphViewModel({
      graph,
      expandedNodes,
      visibleNodes,
      enabledEdgeKinds: allEdgeKinds,
      hideUnconnectedNodes: false,
    });

    expandedNodes.clear();
    visibleNodes.clear();

    assert.deepEqual([...model.expandedNodes], ["root"]);
    assert.equal(model.manuallyVisibleNodes.size, Object.keys(graph.nodes).length);
  });

  it("derives layout-visible nodes through the unconnected-node filter", () => {
    const visibleNodes = new Set(Object.keys(graph.nodes));
    const model = createGraphViewModel({
      graph,
      expandedNodes: new Set(["root", "src"]),
      visibleNodes,
      enabledEdgeKinds: allEdgeKinds,
      hideUnconnectedNodes: true,
    });

    assert.ok(model.layoutVisibleNodes.has("main"));
    assert.ok(model.layoutVisibleNodes.has("helper"));
    assert.ok(model.layoutVisibleNodes.has("src"));
    assert.equal(model.layoutVisibleNodes.has("docs"), false);
  });
});
