/**
 * Benchmark: PR #1 edge lookup optimization in extractLayout()
 *
 * Compares O(E*N) Array.find() vs O(E+N) Map-based lookup for resolving
 * edge metadata (color, kind) during ELK layout extraction.
 *
 * Usage: npx tsx packages/app/benches/elkEdgeLookup.bench.ts
 */

import { performance } from "node:perf_hooks";

// ── Types (mirrored from api/types.ts) ──────────────────────────────

type EdgeKind =
  | "Import"
  | "FunctionCall"
  | "MethodCall"
  | "TypeReference"
  | "Inheritance"
  | "TraitImpl"
  | "VariableUsage";

interface CodeEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
}

const EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

const EDGE_COLORS: Record<EdgeKind, string> = {
  Import: "#6366f1",
  FunctionCall: "#22c55e",
  MethodCall: "#14b8a6",
  TypeReference: "#f59e0b",
  Inheritance: "#ef4444",
  TraitImpl: "#a855f7",
  VariableUsage: "#64748b",
};

// ── Data generators ─────────────────────────────────────────────────

function generateNodeId(i: number): string {
  return `node_${i}`;
}

function generateEdges(count: number): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const nodeCount = Math.max(50, Math.ceil(Math.sqrt(count * 2)));
  for (let i = 0; i < count; i++) {
    const src = Math.floor(Math.random() * nodeCount);
    let tgt = Math.floor(Math.random() * nodeCount);
    if (tgt === src) tgt = (tgt + 1) % nodeCount;
    edges.push({
      source: generateNodeId(src),
      target: generateNodeId(tgt),
      kind: EDGE_KINDS[i % EDGE_KINDS.length],
      weight: 1,
    });
  }
  return edges;
}

/** Simulate the ELK edges that extractLayout would iterate over.
 *  In the real code, each ELK edge references a source/target by ID.
 *  We pick a subset of graph edges to simulate "edges ELK placed." */
function generateElkEdgeQueries(
  graphEdges: CodeEdge[],
  queryCount: number
): Array<{ sourceId: string; targetId: string }> {
  const queries: Array<{ sourceId: string; targetId: string }> = [];
  for (let i = 0; i < queryCount; i++) {
    const edge = graphEdges[i % graphEdges.length];
    queries.push({ sourceId: edge.source, targetId: edge.target });
  }
  return queries;
}

// ── Benchmark implementations ───────────────────────────────────────

/** BEFORE (main): linear scan per edge — O(N) per lookup */
function lookupWithFind(
  graphEdges: CodeEdge[],
  queries: Array<{ sourceId: string; targetId: string }>
): string[] {
  const colors: string[] = [];
  for (const { sourceId, targetId } of queries) {
    const graphEdge = graphEdges.find(
      (e) => e.source === sourceId && e.target === targetId
    );
    colors.push(graphEdge ? EDGE_COLORS[graphEdge.kind] : "#64748b");
  }
  return colors;
}

/** AFTER (PR #1): Map-based lookup — O(1) per lookup */
function lookupWithMap(
  graphEdges: CodeEdge[],
  queries: Array<{ sourceId: string; targetId: string }>
): string[] {
  // Build the lookup map (done once before the loop in the PR)
  const edgeLookup = new Map<string, CodeEdge>();
  for (const e of graphEdges) {
    const key = `${e.source}->${e.target}`;
    if (!edgeLookup.has(key)) edgeLookup.set(key, e);
  }

  const colors: string[] = [];
  for (const { sourceId, targetId } of queries) {
    const graphEdge = edgeLookup.get(`${sourceId}->${targetId}`);
    colors.push(graphEdge ? EDGE_COLORS[graphEdge.kind] : "#64748b");
  }
  return colors;
}

// ── Runner ──────────────────────────────────────────────────────────

interface BenchResult {
  name: string;
  edges: number;
  queries: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  opsPerSec: number;
}

function runBench(
  name: string,
  fn: () => unknown,
  warmupIters: number,
  iters: number
): number[] {
  // Warmup
  for (let i = 0; i < warmupIters; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times;
}

function stats(times: number[]): {
  median: number;
  mean: number;
  min: number;
  max: number;
  p95: number;
} {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    median: sorted[Math.floor(n / 2)],
    mean: times.reduce((a, b) => a + b, 0) / n,
    min: sorted[0],
    max: sorted[n - 1],
    p95: sorted[Math.floor(n * 0.95)],
  };
}

function formatMs(ms: number): string {
  if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)} ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  return `${ms.toFixed(3)} ms`;
}

// ── Main ────────────────────────────────────────────────────────────

const EDGE_COUNTS = [100, 500, 1_000, 5_000, 10_000];
const WARMUP = 50;
const ITERS = 200;

console.log("═══════════════════════════════════════════════════════════════");
console.log("  PR #1 Benchmark: extractLayout() edge lookup");
console.log("  Array.find() (main) vs Map.get() (PR branch)");
console.log(`  ${WARMUP} warmup iterations, ${ITERS} measured iterations`);
console.log("═══════════════════════════════════════════════════════════════\n");

const results: BenchResult[] = [];

for (const edgeCount of EDGE_COUNTS) {
  const graphEdges = generateEdges(edgeCount);
  // Query count matches edge count (realistic: one lookup per ELK edge)
  const queries = generateElkEdgeQueries(graphEdges, edgeCount);

  console.log(`── ${edgeCount} edges, ${queries.length} queries ──`);

  // Baseline: Array.find
  const findTimes = runBench(
    "Array.find",
    () => lookupWithFind(graphEdges, queries),
    WARMUP,
    ITERS
  );
  const findStats = stats(findTimes);

  // Optimized: Map
  const mapTimes = runBench(
    "Map.get",
    () => lookupWithMap(graphEdges, queries),
    WARMUP,
    ITERS
  );
  const mapStats = stats(mapTimes);

  const speedup = findStats.median / mapStats.median;

  console.log(
    `  Array.find  median=${formatMs(findStats.median)}  p95=${formatMs(findStats.p95)}  min=${formatMs(findStats.min)}`
  );
  console.log(
    `  Map.get     median=${formatMs(mapStats.median)}  p95=${formatMs(mapStats.p95)}  min=${formatMs(mapStats.min)}`
  );
  console.log(`  Speedup:    ${speedup.toFixed(1)}x\n`);

  results.push({
    name: "Array.find",
    edges: edgeCount,
    queries: queries.length,
    medianMs: findStats.median,
    meanMs: findStats.mean,
    minMs: findStats.min,
    maxMs: findStats.max,
    p95Ms: findStats.p95,
    opsPerSec: 1000 / findStats.median,
  });
  results.push({
    name: "Map.get",
    edges: edgeCount,
    queries: queries.length,
    medianMs: mapStats.median,
    meanMs: mapStats.mean,
    minMs: mapStats.min,
    maxMs: mapStats.max,
    p95Ms: mapStats.p95,
    opsPerSec: 1000 / mapStats.median,
  });
}

// ── Summary table ───────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Summary");
console.log("═══════════════════════════════════════════════════════════════");
console.log(
  "  Edges   │ Array.find (median) │ Map.get (median)  │ Speedup"
);
console.log(
  "  ────────┼─────────────────────┼───────────────────┼─────────"
);

for (let i = 0; i < results.length; i += 2) {
  const find = results[i];
  const map = results[i + 1];
  const speedup = find.medianMs / map.medianMs;
  console.log(
    `  ${String(find.edges).padStart(6)}  │ ${formatMs(find.medianMs).padStart(19)} │ ${formatMs(map.medianMs).padStart(17)} │ ${speedup.toFixed(1)}x`
  );
}

console.log(
  "\nNote: Map.get timing includes Map construction (done once per layout call)."
);
console.log(
  "At scale the O(1) lookup dominates — construction cost is amortized.\n"
);

// Verify correctness: both approaches should produce identical results
const verifyEdges = generateEdges(100);
const verifyQueries = generateElkEdgeQueries(verifyEdges, 100);
const findResult = lookupWithFind(verifyEdges, verifyQueries);
const mapResult = lookupWithMap(verifyEdges, verifyQueries);
const correct = findResult.every((c, i) => c === mapResult[i]);
console.log(`Correctness check: ${correct ? "PASS ✓" : "FAIL ✗"}`);
