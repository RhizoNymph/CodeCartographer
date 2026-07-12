import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeGraph, EdgeKind } from "../src/api/types.ts";
import {
  effectiveExpandedNodes,
  effectiveEdgeKinds,
  effectiveHideAmbiguous,
  focusVisibleNodes,
  focusExpandedNodes,
} from "../src/stores/graphViewModel.ts";

const allEdgeKinds = new Set<EdgeKind>([
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
]);

// root -> [dirA]; dirA -> [fileA]; fileA -> [fnA1, fnA2]
const graph: CodeGraph = {
  root: "root",
  edgeCount: 1,
  nodeEdgeKinds: new Map<string, EdgeKind[]>(),
  nodes: {
    root: { type: "Directory", id: "root", name: "repo", path: "", children: ["dirA"] },
    dirA: { type: "Directory", id: "dirA", name: "dirA", path: "dirA", children: ["fileA"] },
    fileA: {
      type: "File",
      id: "fileA",
      name: "fileA.py",
      path: "dirA/fileA.py",
      language: "Python",
      children: ["fnA1", "fnA2"],
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
  },
};

describe("module-view derivation", () => {
  it("drops File expansion in module view but keeps Directory expansion", () => {
    const expanded = new Set(["root", "dirA", "fileA"]);
    const eff = effectiveExpandedNodes(graph, expanded, "module");
    assert.ok(eff.has("root"), "directories stay expanded");
    assert.ok(eff.has("dirA"), "directories stay expanded");
    assert.ok(!eff.has("fileA"), "files are not expanded in module view");
  });

  it("preserves the user's expansion set unchanged in symbol view", () => {
    const expanded = new Set(["root", "dirA", "fileA"]);
    const eff = effectiveExpandedNodes(graph, expanded, "symbol");
    // symbol view returns the same set (files remain expandable)
    assert.deepEqual([...eff].sort(), ["dirA", "fileA", "root"]);
  });

  it("does NOT mutate the caller's expanded set", () => {
    const expanded = new Set(["root", "fileA"]);
    effectiveExpandedNodes(graph, expanded, "module");
    assert.ok(expanded.has("fileA"), "input set is left intact (state preserved)");
  });

  it("forces edge kinds to {Import} in module view", () => {
    const eff = effectiveEdgeKinds(allEdgeKinds, "module");
    assert.deepEqual([...eff], ["Import"]);
  });

  it("passes edge kinds through unchanged in symbol view", () => {
    const eff = effectiveEdgeKinds(allEdgeKinds, "symbol");
    assert.equal(eff.size, 7);
  });

  it("ignores the ambiguous filter in module view (imports are exact)", () => {
    assert.equal(effectiveHideAmbiguous(true, "module"), false);
    assert.equal(effectiveHideAmbiguous(true, "symbol"), true);
    assert.equal(effectiveHideAmbiguous(false, "symbol"), false);
  });
});

describe("focus-state derivation", () => {
  it("restricts visible nodes to the neighborhood ids that exist", () => {
    const vis = focusVisibleNodes(graph, ["fnA1", "fileA", "root", "ghost"]);
    assert.deepEqual([...vis].sort(), ["fileA", "fnA1", "root"]);
    assert.ok(!vis.has("ghost"), "non-existent ids are dropped");
    assert.ok(!vis.has("fnA2"), "non-neighborhood nodes are hidden");
  });

  it("expands only containers that hold a neighborhood child", () => {
    // Neighborhood = {fnA1} plus container chain {fileA, dirA, root}
    const exp = focusExpandedNodes(graph, ["fnA1", "fileA", "dirA", "root"]);
    assert.ok(exp.has("fileA"), "file containing fnA1 is expanded");
    assert.ok(exp.has("dirA"), "dir containing fileA is expanded");
    assert.ok(exp.has("root"), "root containing dirA is expanded");
    assert.ok(!exp.has("fnA1"), "code blocks are never in the expanded set");
  });
});
