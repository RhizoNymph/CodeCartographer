import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeGraph, EdgeKind } from "../src/api/types.ts";
import { computeDisplayVisibleNodes } from "../src/stores/visibilityFilter.ts";

const allEdgeKinds = new Set<EdgeKind>([
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
]);

// Connectivity derived from the (server-side) edges:
//   fn1 -> fn2  (FunctionCall)
//   orphanFn -> fn1  (Import)
const graph: CodeGraph = {
  root: "root",
  edgeCount: 2,
  nodeEdgeKinds: new Map<string, EdgeKind[]>([
    ["fn1", ["FunctionCall", "Import"]],
    ["fn2", ["FunctionCall"]],
    ["orphanFn", ["Import"]],
  ]),
  nodes: {
    root: {
      type: "Directory",
      id: "root",
      name: "repo",
      path: "",
      children: ["src"],
    },
    src: {
      type: "Directory",
      id: "src",
      name: "src",
      path: "src",
      children: ["file1", "file2", "orphanFile", "unusedFile"],
    },
    file1: {
      type: "File",
      id: "file1",
      name: "a.ts",
      path: "src/a.ts",
      language: "TypeScript",
      children: ["fn1"],
    },
    fn1: {
      type: "CodeBlock",
      id: "fn1",
      name: "a",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 1 },
      signature: null,
      visibility: null,
      parent: "file1",
      children: [],
    },
    file2: {
      type: "File",
      id: "file2",
      name: "b.ts",
      path: "src/b.ts",
      language: "TypeScript",
      children: ["fn2"],
    },
    fn2: {
      type: "CodeBlock",
      id: "fn2",
      name: "b",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 1 },
      signature: null,
      visibility: null,
      parent: "file2",
      children: [],
    },
    orphanFile: {
      type: "File",
      id: "orphanFile",
      name: "orphan.ts",
      path: "src/orphan.ts",
      language: "TypeScript",
      children: ["orphanFn"],
    },
    orphanFn: {
      type: "CodeBlock",
      id: "orphanFn",
      name: "orphan",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 1 },
      signature: null,
      visibility: null,
      parent: "orphanFile",
      children: [],
    },
    unusedFile: {
      type: "File",
      id: "unusedFile",
      name: "unused.ts",
      path: "src/unused.ts",
      language: "TypeScript",
      children: ["unusedFn"],
    },
    unusedFn: {
      type: "CodeBlock",
      id: "unusedFn",
      name: "unused",
      kind: "Function",
      span: { start_line: 1, start_col: 0, end_line: 2, end_col: 1 },
      signature: null,
      visibility: null,
      parent: "unusedFile",
      children: [],
    },
  },
};

describe("computeDisplayVisibleNodes", () => {
  it("returns manual visibility unchanged when hiding unconnected nodes is off", () => {
    const visible = new Set(["file1", "unusedFile"]);
    const result = computeDisplayVisibleNodes(graph, visible, allEdgeKinds, false);

    assert.deepEqual([...result].sort(), ["file1", "unusedFile"]);
    assert.notEqual(result, visible);
  });

  it("keeps connected endpoints and ancestors while filtering unconnected siblings", () => {
    const visible = new Set(Object.keys(graph.nodes));
    const result = computeDisplayVisibleNodes(graph, visible, allEdgeKinds, true);

    assert.ok(result.has("fn1"));
    assert.ok(result.has("fn2"));
    assert.ok(result.has("file1"));
    assert.ok(result.has("file2"));
    assert.ok(result.has("src"));
    assert.ok(result.has("root"));
    assert.equal(result.has("unusedFile"), false);
    assert.equal(result.has("unusedFn"), false);
  });

  it("respects enabled edge kinds while collapsing hidden endpoints to visible ancestors", () => {
    const visible = new Set(Object.keys(graph.nodes));
    visible.delete("fn2");

    const onlyFunctionCalls = new Set<EdgeKind>(["FunctionCall"]);
    const result = computeDisplayVisibleNodes(graph, visible, onlyFunctionCalls, true);

    assert.equal(result.has("fn1"), true);
    assert.equal(result.has("file1"), true);
    assert.equal(result.has("file2"), true);
    assert.equal(result.has("fn2"), false);
    assert.equal(result.has("orphanFn"), false);
  });

  it("keeps visible containers connected through hidden descendants", () => {
    const visible = new Set(Object.keys(graph.nodes));
    visible.delete("fn1");
    visible.delete("fn2");

    const result = computeDisplayVisibleNodes(graph, visible, allEdgeKinds, true);

    assert.equal(result.has("file1"), true);
    assert.equal(result.has("file2"), true);
    assert.equal(result.has("fn1"), false);
    assert.equal(result.has("fn2"), false);
    assert.equal(result.has("unusedFile"), false);
  });
});
