import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EdgeKind, Resolution, SubGraph } from "../src/api/types.ts";
import {
  deriveEdgeKindCounts,
  unknownEdgeKindCounts,
  buildLegendRows,
  edgeKindLabel,
  legendEdgeKinds,
} from "../src/canvas/legend/edgeLegendModel.ts";

const allKinds: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

function sub(partial: Partial<SubGraph>): SubGraph {
  return { edges: [], aggregated_edges: [], ...partial };
}

let edgeSeq = 0;
function directEdge(kind: EdgeKind, weight = 1, resolution: Resolution = "SameFile") {
  edgeSeq += 1;
  return { source: `s${edgeSeq}`, target: `t${edgeSeq}`, kind, weight, resolution };
}

function aggEdge(kind: EdgeKind, count: number) {
  edgeSeq += 1;
  return { source: `as${edgeSeq}`, target: `at${edgeSeq}`, kind, count };
}

describe("deriveEdgeKindCounts", () => {
  it("reports 0 (not null) for a fetched kind with no edges in the view", () => {
    const counts = deriveEdgeKindCounts(sub({}), allKinds);
    for (const kind of allKinds) {
      assert.equal(counts[kind], 0, `${kind} should be 0`);
    }
  });

  it("reports null for kinds that were never fetched, so 'unknown' is not confused with 'zero'", () => {
    const counts = deriveEdgeKindCounts(
      sub({ edges: [directEdge("Import")] }),
      ["Import"]
    );
    assert.equal(counts.Import, 1);
    assert.equal(counts.FunctionCall, null);
    assert.equal(counts.VariableUsage, null);
    // Every kind is still a key of the record.
    assert.deepEqual(Object.keys(counts).sort(), [...allKinds].sort());
  });

  it("counts each direct edge as exactly one underlying edge", () => {
    const counts = deriveEdgeKindCounts(
      sub({
        edges: [directEdge("Import"), directEdge("Import"), directEdge("FunctionCall")],
      }),
      allKinds
    );
    assert.equal(counts.Import, 2);
    assert.equal(counts.FunctionCall, 1);
    assert.equal(counts.MethodCall, 0);
  });

  it("ignores direct-edge weight (weight is occurrence frequency, not edge count)", () => {
    const counts = deriveEdgeKindCounts(sub({ edges: [directEdge("MethodCall", 7)] }), allKinds);
    assert.equal(counts.MethodCall, 1);
  });

  it("adds the collapsed count of each aggregated edge", () => {
    const counts = deriveEdgeKindCounts(
      sub({ aggregated_edges: [aggEdge("Inheritance", 4), aggEdge("Inheritance", 3)] }),
      allKinds
    );
    assert.equal(counts.Inheritance, 7);
  });

  it("sums direct and aggregated contributions per kind", () => {
    const counts = deriveEdgeKindCounts(
      sub({
        edges: [directEdge("Import"), directEdge("Import", 5), directEdge("TraitImpl")],
        aggregated_edges: [aggEdge("Import", 10), aggEdge("VariableUsage", 2)],
      }),
      allKinds
    );
    assert.equal(counts.Import, 12); // 2 direct + 10 aggregated
    assert.equal(counts.TraitImpl, 1);
    assert.equal(counts.VariableUsage, 2);
    assert.equal(counts.TypeReference, 0);
  });

  it("counts edges of a kind that was fetched even if it is not in the fetched list twice over", () => {
    // Defensive: the payload is authoritative for which kinds have edges; the
    // fetched list only decides which kinds are known-vs-unknown.
    const counts = deriveEdgeKindCounts(
      sub({ edges: [directEdge("Import"), directEdge("MethodCall")] }),
      ["Import", "MethodCall"]
    );
    assert.equal(counts.Import, 1);
    assert.equal(counts.MethodCall, 1);
    assert.equal(counts.Inheritance, null);
  });

  it("excludes ambiguous direct edges when the view hides them (mirrors the render path)", () => {
    const payload = sub({
      edges: [
        directEdge("FunctionCall", 1, "Ambiguous"),
        directEdge("FunctionCall", 1, "GlobalUnique"),
      ],
      aggregated_edges: [aggEdge("FunctionCall", 3)],
    });
    assert.equal(deriveEdgeKindCounts(payload, allKinds, false).FunctionCall, 5);
    // Aggregated edges carry no single resolution, so they are counted either way.
    assert.equal(deriveEdgeKindCounts(payload, allKinds, true).FunctionCall, 4);
  });

  it("returns a fresh record each call", () => {
    const first = deriveEdgeKindCounts(sub({ edges: [directEdge("Import")] }), allKinds);
    const second = deriveEdgeKindCounts(sub({}), allKinds);
    assert.equal(first.Import, 1);
    assert.equal(second.Import, 0);
    assert.notEqual(unknownEdgeKindCounts(), unknownEdgeKindCounts());
  });
});

describe("unknownEdgeKindCounts", () => {
  it("marks every kind unknown", () => {
    const counts = unknownEdgeKindCounts();
    for (const kind of allKinds) {
      assert.equal(counts[kind], null);
    }
  });
});

describe("legendEdgeKinds", () => {
  it("exposes every edge kind in symbol view", () => {
    assert.deepEqual(legendEdgeKinds("symbol"), allKinds);
  });

  it("is import-only in module view (effective kinds are forced to {Import})", () => {
    assert.deepEqual(legendEdgeKinds("module"), ["Import"]);
  });
});

describe("buildLegendRows -- symbol view", () => {
  const enabled = new Set<EdgeKind>(["Import", "FunctionCall", "MethodCall"]);
  // Only enabled kinds are fetched, so disabled kinds are unknown (null).
  const counts = {
    ...unknownEdgeKindCounts(),
    Import: 12,
    FunctionCall: 5,
    MethodCall: 0,
  };

  const rows = buildLegendRows({ counts, enabledEdgeKinds: enabled, viewMode: "symbol" });
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  it("emits one row per edge kind, in canonical order", () => {
    assert.deepEqual(rows.map((r) => r.kind), allKinds);
  });

  it("carries a human-readable label", () => {
    assert.equal(byKind.get("Import")!.label, edgeKindLabel("Import"));
  });

  it("reports the view count for enabled kinds", () => {
    assert.equal(byKind.get("Import")!.count, 12);
    assert.equal(byKind.get("FunctionCall")!.count, 5);
  });

  it("marks an enabled kind with edges as active and interactive", () => {
    const importRow = byKind.get("Import")!;
    assert.equal(importRow.enabled, true);
    assert.equal(importRow.interactive, true);
    assert.equal(importRow.dimmed, false);
    assert.equal(importRow.struck, false);
  });

  it("dims and disables interaction for an enabled kind with zero edges in the view", () => {
    const methodRow = byKind.get("MethodCall")!;
    assert.equal(methodRow.count, 0);
    assert.equal(methodRow.enabled, true);
    assert.equal(methodRow.interactive, false);
    assert.equal(methodRow.dimmed, true);
  });

  it("dims and strikes a toggled-off kind but keeps it clickable so it can be re-enabled", () => {
    const typeRow = byKind.get("TypeReference")!;
    assert.equal(typeRow.enabled, false);
    assert.equal(typeRow.count, null);
    assert.equal(typeRow.struck, true);
    assert.equal(typeRow.dimmed, true);
    assert.equal(typeRow.interactive, true);
  });

  it("keeps a row with an unknown count clickable even while it is enabled", () => {
    // Transient state: the user just enabled a kind and the relayout that will
    // produce its count has not landed yet.
    const pending = buildLegendRows({
      counts: unknownEdgeKindCounts(),
      enabledEdgeKinds: new Set<EdgeKind>(allKinds),
      viewMode: "symbol",
    });
    for (const row of pending) {
      assert.equal(row.count, null);
      assert.equal(row.enabled, true);
      assert.equal(row.interactive, true);
      assert.equal(row.dimmed, false);
    }
  });

  it("treats an empty enabled set as everything toggled off", () => {
    const offRows = buildLegendRows({
      counts,
      enabledEdgeKinds: new Set<EdgeKind>(),
      viewMode: "symbol",
    });
    assert.equal(offRows.every((r) => !r.enabled), true);
    assert.equal(offRows.every((r) => r.struck), true);
    assert.equal(offRows.every((r) => r.dimmed), true);
    assert.equal(offRows.every((r) => r.interactive), true);
  });
});

describe("buildLegendRows -- module view", () => {
  const counts = { ...unknownEdgeKindCounts(), Import: 41 };
  const allEnabled = new Set<EdgeKind>(allKinds);

  it("shows only the Import row regardless of enabled kinds", () => {
    const rows = buildLegendRows({ counts, enabledEdgeKinds: allEnabled, viewMode: "module" });
    assert.deepEqual(rows.map((r) => r.kind), ["Import"]);
  });

  it("keeps the Import row non-interactive (module view is import-only by construction)", () => {
    const rows = buildLegendRows({ counts, enabledEdgeKinds: allEnabled, viewMode: "module" });
    assert.equal(rows[0].interactive, false);
    assert.equal(rows[0].enabled, true);
    assert.equal(rows[0].struck, false);
    assert.equal(rows[0].dimmed, false);
  });

  it("reports an accurate Import count", () => {
    const rows = buildLegendRows({ counts, enabledEdgeKinds: allEnabled, viewMode: "module" });
    assert.equal(rows[0].count, 41);
  });

  it("shows Import as active even when the user has it toggled off in saved state", () => {
    // Module view forces effective kinds to {Import}; the saved toggle state is
    // preserved but ignored, so the legend must not render Import as off.
    const rows = buildLegendRows({
      counts,
      enabledEdgeKinds: new Set<EdgeKind>(["FunctionCall"]),
      viewMode: "module",
    });
    assert.equal(rows[0].enabled, true);
    assert.equal(rows[0].struck, false);
  });

  it("dims the Import row when the view has no import edges", () => {
    const rows = buildLegendRows({
      counts: { ...unknownEdgeKindCounts(), Import: 0 },
      enabledEdgeKinds: allEnabled,
      viewMode: "module",
    });
    assert.equal(rows[0].count, 0);
    assert.equal(rows[0].dimmed, true);
    assert.equal(rows[0].interactive, false);
  });
});

describe("edgeKindLabel", () => {
  it("gives every kind a distinct human-readable label", () => {
    const labels = allKinds.map(edgeKindLabel);
    assert.equal(new Set(labels).size, allKinds.length);
    for (const label of labels) {
      assert.equal(label.length > 0, true);
      // Human-readable: never a raw CamelCase identifier like "FunctionCall".
      assert.equal(/^[A-Z][a-z]+( [a-z]+)*$/.test(label), true, `bad label: ${label}`);
    }
  });
});
