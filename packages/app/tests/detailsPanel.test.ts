import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  CodeBlockNode,
  CodeEdge,
  CodeNode,
  DirectoryNode,
  EdgeKind,
  FileNode,
  Neighborhood,
  Resolution,
} from "../src/api/types.ts";
import {
  DETAILS_EDGE_KINDS,
  buildDetailsEdgeModel,
  buildNodeSummary,
  fallbackEndpointName,
  formatSpan,
} from "../src/details/detailsPanelModel.ts";

// ---------------------------------------------------------------- fixtures

function edge(
  source: string,
  target: string,
  kind: EdgeKind,
  weight = 1,
  resolution: Resolution = "SameFile"
): CodeEdge {
  return { source, target, kind, weight, resolution };
}

function hood(focus: string, edges: CodeEdge[], depth = 1): Neighborhood {
  const ids = new Set<string>([focus]);
  for (const e of edges) {
    ids.add(e.source);
    ids.add(e.target);
  }
  return { focus, depth, node_ids: [...ids], edges };
}

function file(id: string, name: string, path: string): FileNode {
  return { type: "File", id, name, path, language: "Rust", children: [] };
}

function dir(id: string, name: string, path: string): DirectoryNode {
  return { type: "Directory", id, name, path, children: [] };
}

function block(
  id: string,
  name: string,
  overrides: Partial<CodeBlockNode> = {}
): CodeBlockNode {
  return {
    type: "CodeBlock",
    id,
    name,
    kind: "Function",
    span: { start_line: 10, start_col: 0, end_line: 20, end_col: 1 },
    signature: `fn ${name}()`,
    visibility: "Public",
    parent: "src/lib.rs",
    children: [],
    ...overrides,
  };
}

function nodeMap(...nodes: CodeNode[]): Record<string, CodeNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]));
}

const SELECTED = "src/lib.rs::target@10";

// ---------------------------------------------------- buildDetailsEdgeModel

describe("buildDetailsEdgeModel", () => {
  it("yields empty sections when there is no neighborhood yet", () => {
    const model = buildDetailsEdgeModel(SELECTED, null, {});

    assert.equal(model.nodeId, SELECTED);
    assert.deepEqual(model.incoming, {
      direction: "incoming",
      total: 0,
      groups: [],
    });
    assert.deepEqual(model.outgoing, {
      direction: "outgoing",
      total: 0,
      groups: [],
    });
  });

  it("discards a neighborhood focused on a different node (stale response)", () => {
    const stale = hood("other", [edge("other", "x", "FunctionCall")]);

    const model = buildDetailsEdgeModel(SELECTED, stale, {});

    assert.equal(model.incoming.total, 0);
    assert.equal(model.outgoing.total, 0);
    assert.deepEqual(model.incoming.groups, []);
    assert.deepEqual(model.outgoing.groups, []);
  });

  it("splits edges into incoming (target is selected) and outgoing (source is selected)", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge("caller", SELECTED, "FunctionCall"),
        edge(SELECTED, "callee", "FunctionCall"),
      ]),
      {}
    );

    assert.equal(model.incoming.total, 1);
    assert.equal(model.outgoing.total, 1);
    assert.deepEqual(
      model.incoming.groups[0].endpoints.map((e) => e.nodeId),
      ["caller"]
    );
    assert.deepEqual(
      model.outgoing.groups[0].endpoints.map((e) => e.nodeId),
      ["callee"]
    );
  });

  it("ignores neighborhood edges that do not touch the selected node", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge("caller", SELECTED, "FunctionCall"),
        // neighbor-to-neighbor: present in the BFS payload, not our business
        edge("caller", "callee", "MethodCall"),
      ]),
      {}
    );

    assert.equal(model.incoming.total, 1);
    assert.equal(model.outgoing.total, 0);
    assert.equal(model.incoming.groups.length, 1);
  });

  it("groups by edge kind in canonical order and omits kinds with no edges", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "v", "VariableUsage"),
        edge(SELECTED, "i", "Import"),
        edge(SELECTED, "m", "MethodCall"),
      ]),
      {}
    );

    assert.deepEqual(
      model.outgoing.groups.map((g) => g.kind),
      ["Import", "MethodCall", "VariableUsage"]
    );
    // canonical order matches the exported kind order
    const order = DETAILS_EDGE_KINDS.filter((k) =>
      model.outgoing.groups.some((g) => g.kind === k)
    );
    assert.deepEqual(
      model.outgoing.groups.map((g) => g.kind),
      order
    );
  });

  it("counts edges per kind and totals them per direction", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "a", "FunctionCall"),
        edge(SELECTED, "b", "FunctionCall"),
        edge(SELECTED, "c", "TypeReference"),
      ]),
      {}
    );

    const byKind = Object.fromEntries(
      model.outgoing.groups.map((g) => [g.kind, g.count])
    );
    assert.deepEqual(byKind, { FunctionCall: 2, TypeReference: 1 });
    assert.equal(model.outgoing.total, 3);
  });

  it("collapses repeated edges to one endpoint of one kind into a single row with a count", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "a", "FunctionCall"),
        edge(SELECTED, "a", "FunctionCall"),
        edge(SELECTED, "a", "FunctionCall"),
      ]),
      {}
    );

    const group = model.outgoing.groups[0];
    assert.equal(group.count, 3);
    assert.equal(group.endpoints.length, 1);
    assert.equal(group.endpoints[0].count, 3);
  });

  it("counts an edge once regardless of its weight", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [edge(SELECTED, "a", "FunctionCall", 7)]),
      {}
    );

    assert.equal(model.outgoing.groups[0].count, 1);
    assert.equal(model.outgoing.groups[0].endpoints[0].count, 1);
  });

  it("lists the same endpoint under each kind that connects it", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "a", "FunctionCall"),
        edge(SELECTED, "a", "TypeReference"),
      ]),
      {}
    );

    assert.deepEqual(
      model.outgoing.groups.map((g) => [g.kind, g.endpoints[0].nodeId]),
      [
        ["FunctionCall", "a"],
        ["TypeReference", "a"],
      ]
    );
  });

  it("lists a self-loop once, as outgoing, flagged", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [edge(SELECTED, SELECTED, "FunctionCall")]),
      nodeMap(block(SELECTED, "target"))
    );

    assert.equal(model.incoming.total, 0);
    assert.deepEqual(model.incoming.groups, []);
    assert.equal(model.outgoing.total, 1);
    const row = model.outgoing.groups[0].endpoints[0];
    assert.equal(row.nodeId, SELECTED);
    assert.equal(row.selfLoop, true);
    assert.equal(row.name, "target");
  });

  it("marks non-self-loop rows as not self-loops", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [edge(SELECTED, "a", "FunctionCall")]),
      {}
    );

    assert.equal(model.outgoing.groups[0].endpoints[0].selfLoop, false);
  });

  it("orders endpoints by count desc, then name, then id", () => {
    const nodes = nodeMap(
      block("id-1", "zeta"),
      block("id-2", "alpha"),
      block("id-3", "alpha"),
      block("id-4", "beta")
    );
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "id-1", "FunctionCall"),
        edge(SELECTED, "id-3", "FunctionCall"),
        edge(SELECTED, "id-2", "FunctionCall"),
        edge(SELECTED, "id-4", "FunctionCall"),
        edge(SELECTED, "id-4", "FunctionCall"),
      ]),
      nodes
    );

    assert.deepEqual(
      model.outgoing.groups[0].endpoints.map((e) => [e.name, e.nodeId, e.count]),
      [
        ["beta", "id-4", 2],
        ["alpha", "id-2", 1],
        ["alpha", "id-3", 1],
        ["zeta", "id-1", 1],
      ]
    );
  });

  it("resolves endpoint name, detail and block kind from the node map", () => {
    const nodes = nodeMap(
      file("src/util.rs", "util.rs", "src/util.rs"),
      dir("src", "src", "src"),
      block("src/util.rs::helper@4", "helper", { kind: "Class" })
    );
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "src/util.rs", "Import"),
        edge(SELECTED, "src", "Import"),
        edge(SELECTED, "src/util.rs::helper@4", "TypeReference"),
      ]),
      nodes
    );

    const imports = model.outgoing.groups[0].endpoints;
    assert.deepEqual(
      imports.map((e) => [e.name, e.detail, e.blockKind]),
      [
        ["src", "src", null],
        ["util.rs", "src/util.rs", null],
      ]
    );

    const typeRefs = model.outgoing.groups[1].endpoints;
    assert.deepEqual(typeRefs[0].name, "helper");
    assert.deepEqual(typeRefs[0].detail, "fn helper()");
    assert.deepEqual(typeRefs[0].blockKind, "Class");
  });

  it("leaves detail null for a code block without a signature", () => {
    const nodes = nodeMap(block("b", "noSig", { signature: null }));
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [edge(SELECTED, "b", "FunctionCall")]),
      nodes
    );

    assert.equal(model.outgoing.groups[0].endpoints[0].detail, null);
  });

  it("falls back to an id-derived name when the endpoint node is unknown", () => {
    const model = buildDetailsEdgeModel(
      SELECTED,
      hood(SELECTED, [
        edge(SELECTED, "src/a.ts::foo@12", "FunctionCall"),
        edge(SELECTED, "src/deep/b.ts", "FunctionCall"),
      ]),
      {}
    );

    const rows = model.outgoing.groups[0].endpoints;
    assert.deepEqual(
      rows.map((r) => [r.name, r.detail, r.blockKind]),
      [
        ["b.ts", null, null],
        ["foo", null, null],
      ]
    );
  });
});

// ---------------------------------------------------- fallbackEndpointName

describe("fallbackEndpointName", () => {
  it("strips the @line suffix and the file-path prefix of a code block id", () => {
    assert.equal(fallbackEndpointName("src/lib.rs::render@42"), "render");
  });

  it("uses the last path segment of a file or directory id", () => {
    assert.equal(fallbackEndpointName("src/canvas/Canvas.tsx"), "Canvas.tsx");
    assert.equal(fallbackEndpointName("src"), "src");
  });

  it("keeps a name containing @ that is not a line suffix", () => {
    assert.equal(fallbackEndpointName("pkg/@scope/mod.ts"), "mod.ts");
  });

  it("never returns an empty string", () => {
    assert.equal(fallbackEndpointName(""), "unknown");
    assert.equal(fallbackEndpointName("src/"), "src/");
  });
});

// ------------------------------------------------------------- formatSpan

describe("formatSpan", () => {
  it("renders a line range", () => {
    assert.equal(
      formatSpan({ start_line: 10, start_col: 0, end_line: 20, end_col: 1 }),
      "10–20"
    );
  });

  it("renders a single line without a range", () => {
    assert.equal(
      formatSpan({ start_line: 7, start_col: 0, end_line: 7, end_col: 9 }),
      "7"
    );
  });
});

// --------------------------------------------------------- buildNodeSummary

describe("buildNodeSummary", () => {
  it("summarizes a file with its path, language and symbol count", () => {
    const node: FileNode = {
      ...file("src/lib.rs", "lib.rs", "src/lib.rs"),
      children: ["a", "b"],
    };

    const summary = buildNodeSummary(node);

    assert.equal(summary.id, "src/lib.rs");
    assert.equal(summary.name, "lib.rs");
    assert.equal(summary.badge, "File");
    assert.equal(summary.blockKind, null);
    assert.deepEqual(summary.facts, [
      { label: "Path", value: "src/lib.rs", mono: true },
      { label: "Language", value: "Rust" },
      { label: "Symbols", value: "2" },
    ]);
  });

  it("reports an unknown language for a file with none", () => {
    const node: FileNode = { ...file("a", "a.txt", "a.txt"), language: null };

    assert.deepEqual(buildNodeSummary(node).facts[1], {
      label: "Language",
      value: "Unknown",
    });
  });

  it("summarizes a directory with its path and item count", () => {
    const node: DirectoryNode = { ...dir("src", "src", "src"), children: ["x"] };

    const summary = buildNodeSummary(node);

    assert.equal(summary.badge, "Directory");
    assert.equal(summary.blockKind, null);
    assert.deepEqual(summary.facts, [
      { label: "Path", value: "src", mono: true },
      { label: "Items", value: "1" },
    ]);
  });

  it("summarizes a code block with signature, visibility and span", () => {
    const summary = buildNodeSummary(
      block("src/lib.rs::render@10", "render", { kind: "Class" })
    );

    assert.equal(summary.name, "render");
    assert.equal(summary.badge, "Class");
    assert.equal(summary.blockKind, "Class");
    assert.deepEqual(summary.facts, [
      { label: "Signature", value: "fn render()", mono: true },
      { label: "Visibility", value: "Public" },
      { label: "Lines", value: "10–20" },
    ]);
  });

  it("omits absent signature and visibility facts", () => {
    const summary = buildNodeSummary(
      block("b", "bare", { signature: null, visibility: null })
    );

    assert.deepEqual(summary.facts, [{ label: "Lines", value: "10–20" }]);
  });
});
