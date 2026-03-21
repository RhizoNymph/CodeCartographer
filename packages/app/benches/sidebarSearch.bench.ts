/**
 * Benchmark: PR #3 sidebar search filtering optimization
 *
 * Compares O(N*D) per-TreeItem recursive matchesQuery() vs O(N) single-pass
 * computeMatchingIds() that builds a Set<string> for O(1) membership checks.
 *
 * Usage: npx tsx packages/app/benches/sidebarSearch.bench.ts
 */

import { performance } from "node:perf_hooks";

// ── Types (mirrored from api/types.ts) ──────────────────────────────

type BlockKind =
  | "Function"
  | "Class"
  | "Struct"
  | "Enum"
  | "Trait"
  | "Interface"
  | "Impl"
  | "Module"
  | "Constant"
  | "TypeAlias";

interface DirectoryNode {
  type: "Directory";
  id: string;
  name: string;
  path: string;
  children: string[];
}

interface FileNode {
  type: "File";
  id: string;
  name: string;
  path: string;
  language: string | null;
  children: string[];
}

interface CodeBlockNode {
  type: "CodeBlock";
  id: string;
  name: string;
  kind: BlockKind;
  span: { start_line: number; start_col: number; end_line: number; end_col: number };
  signature: string | null;
  visibility: string | null;
  parent: string;
  children: string[];
}

type CodeNode = DirectoryNode | FileNode | CodeBlockNode;

interface CodeGraph {
  nodes: Record<string, CodeNode>;
  root: string;
}

// ── Data generators ─────────────────────────────────────────────────

const BLOCK_KINDS: BlockKind[] = [
  "Function", "Class", "Struct", "Enum", "Trait",
  "Interface", "Impl", "Module", "Constant", "TypeAlias",
];

const DIR_NAMES = [
  "src", "lib", "utils", "core", "api", "models", "services",
  "handlers", "middleware", "config", "tests", "helpers",
];

const FILE_NAMES = [
  "index.ts", "main.rs", "config.py", "server.ts", "router.rs",
  "database.ts", "auth.rs", "parser.py", "schema.ts", "types.rs",
  "utils.ts", "helpers.py", "middleware.ts", "logger.rs", "cache.ts",
];

const SYMBOL_NAMES = [
  "handleRequest", "parseInput", "validateSchema", "serializeOutput",
  "fetchData", "transformResult", "computeHash", "renderTemplate",
  "buildQuery", "executeCommand", "processEvent", "createConnection",
  "initializeApp", "shutdownGracefully", "loadConfiguration",
  "authenticateUser", "authorizeAccess", "encryptPayload",
  "decryptMessage", "compressData", "decompressStream",
  "formatResponse", "logMetric", "emitEvent", "subscribe",
  "UserService", "DataManager", "ConfigLoader", "EventBus",
  "CacheLayer", "PoolManager", "TaskScheduler", "RouteHandler",
];

/**
 * Generate a realistic tree-shaped graph with configurable depth.
 *
 * Structure: root → nested dirs → files → code blocks (nested classes/methods)
 *
 * @param nodeTarget Approximate total node count
 * @param maxDepth   Max directory nesting depth (deeper = more redundant subtree walks)
 */
function generateGraph(nodeTarget: number, maxDepth: number = 6): CodeGraph {
  const nodes: Record<string, CodeNode> = {};
  let nextId = 0;

  function makeId(): string {
    return `node_${nextId++}`;
  }

  const rootId = makeId();
  const rootChildren: string[] = [];
  nodes[rootId] = {
    type: "Directory",
    id: rootId,
    name: "project",
    path: "/project",
    children: rootChildren,
  };

  // Target branching factor based on depth to hit node count
  // Branching ~ (nodeTarget)^(1/maxDepth)
  const branchFactor = Math.max(2, Math.round(Math.pow(nodeTarget, 1 / maxDepth)));

  function buildTree(
    parentPath: string,
    parentChildren: string[],
    currentDepth: number
  ): void {
    if (nextId >= nodeTarget) return;

    // Deeper levels: fewer dirs, more files/blocks (leaf-heavy)
    const isLeafLevel = currentDepth >= maxDepth - 1;
    const numItems = Math.min(branchFactor, Math.ceil((nodeTarget - nextId) / 3));

    for (let i = 0; i < numItems && nextId < nodeTarget; i++) {
      if (!isLeafLevel) {
        // Create a directory node
        const dirId = makeId();
        const dirName = DIR_NAMES[(currentDepth * numItems + i) % DIR_NAMES.length];
        const dirPath = `${parentPath}/${dirName}`;
        const dirChildren: string[] = [];

        nodes[dirId] = {
          type: "Directory",
          id: dirId,
          name: dirName,
          path: dirPath,
          children: dirChildren,
        };
        parentChildren.push(dirId);

        buildTree(dirPath, dirChildren, currentDepth + 1);
      } else {
        // Create a file with code block children
        const fileId = makeId();
        const fileName = FILE_NAMES[i % FILE_NAMES.length];
        const filePath = `${parentPath}/${fileName}`;
        const fileChildren: string[] = [];

        nodes[fileId] = {
          type: "File",
          id: fileId,
          name: fileName,
          path: filePath,
          language: "TypeScript",
          children: fileChildren,
        };
        parentChildren.push(fileId);

        // Add code blocks (some with nested children for depth)
        const numBlocks = Math.min(4, nodeTarget - nextId);
        for (let b = 0; b < numBlocks && nextId < nodeTarget; b++) {
          const blockId = makeId();
          const blockName = SYMBOL_NAMES[(nextId) % SYMBOL_NAMES.length];
          const kind = BLOCK_KINDS[b % BLOCK_KINDS.length];
          const blockChildren: string[] = [];

          nodes[blockId] = {
            type: "CodeBlock",
            id: blockId,
            name: blockName,
            kind,
            span: { start_line: b * 20, start_col: 0, end_line: b * 20 + 15, end_col: 0 },
            signature: `${kind.toLowerCase()} ${blockName}()`,
            visibility: "Public",
            parent: fileId,
            children: blockChildren,
          };
          fileChildren.push(blockId);

          // Nested methods inside class/struct blocks
          if ((kind === "Class" || kind === "Struct") && nextId < nodeTarget) {
            const numMethods = Math.min(3, nodeTarget - nextId);
            for (let m = 0; m < numMethods && nextId < nodeTarget; m++) {
              const methodId = makeId();
              const methodName = SYMBOL_NAMES[(nextId) % SYMBOL_NAMES.length];

              nodes[methodId] = {
                type: "CodeBlock",
                id: methodId,
                name: methodName,
                kind: "Function",
                span: { start_line: b * 20 + m * 5, start_col: 2, end_line: b * 20 + m * 5 + 4, end_col: 0 },
                signature: `fn ${methodName}()`,
                visibility: "Public",
                parent: blockId,
                children: [],
              };
              blockChildren.push(methodId);
            }
          }
        }
      }
    }
  }

  buildTree("/project", rootChildren, 1);

  return { nodes, root: rootId };
}

/** Measure tree depth for reporting */
function measureDepth(graph: CodeGraph): number {
  let maxDepth = 0;
  function walk(nodeId: string, depth: number) {
    maxDepth = Math.max(maxDepth, depth);
    const node = graph.nodes[nodeId];
    if (node) {
      for (const childId of node.children) {
        walk(childId, depth + 1);
      }
    }
  }
  walk(graph.root, 0);
  return maxDepth;
}

// ── Benchmark implementations ───────────────────────────────────────

/**
 * BEFORE (main): per-TreeItem recursive matchesQuery()
 *
 * Each TreeItem calls this during render — walks the entire subtree
 * to check if the node or any descendant matches. O(N*D) total when
 * called for every node in the tree.
 */
function matchesQuery(
  node: CodeNode,
  query: string,
  graph: { nodes: Record<string, CodeNode> }
): boolean {
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;

  // Check if any descendant matches
  for (const childId of node.children) {
    const child = graph.nodes[childId];
    if (child && matchesQuery(child, query, graph)) return true;
  }

  return false;
}

/**
 * Simulate the actual React render pass using the old approach.
 *
 * In the Sidebar component, TreeItem is rendered recursively:
 *   1. Each TreeItem calls matchesQuery(node, query, graph) — walks subtree
 *   2. If false, returns null (children are never rendered)
 *   3. If true AND expanded, renders children which each call matchesQuery again
 *
 * This means parent nodes redundantly re-walk subtrees that children
 * will also walk. Total work = sum of subtree sizes for all rendered nodes.
 */
function filterWithRecursive(
  graph: CodeGraph,
  query: string
): number {
  let visibleCount = 0;

  function renderTreeItem(nodeId: string): void {
    const node = graph.nodes[nodeId];
    if (!node) return;

    // Each TreeItem calls matchesQuery — full subtree walk
    if (!matchesQuery(node, query, graph)) return;

    visibleCount++;

    // If matched (and expanded — assume all expanded during search),
    // children are rendered, each calling matchesQuery again
    for (const childId of node.children) {
      renderTreeItem(childId);
    }
  }

  // Sidebar renders root's children directly
  const root = graph.nodes[graph.root];
  if (root) {
    for (const childId of root.children) {
      renderTreeItem(childId);
    }
  }

  return visibleCount;
}

/**
 * AFTER (PR #3): single-pass computeMatchingIds()
 *
 * Walks the tree once bottom-up, collecting all matching IDs (nodes
 * whose name matches + their ancestors). Returns a Set for O(1) lookup.
 */
function computeMatchingIds(
  graph: { nodes: Record<string, CodeNode>; root: string },
  query: string
): Set<string> {
  const result = new Set<string>();
  const q = query.toLowerCase();

  function visit(nodeId: string): boolean {
    const node = graph.nodes[nodeId];
    if (!node) return false;

    const selfMatches = node.name.toLowerCase().includes(q);
    let childMatches = false;

    for (const childId of node.children) {
      if (visit(childId)) {
        childMatches = true;
      }
    }

    if (selfMatches || childMatches) {
      result.add(nodeId);
      return true;
    }

    return false;
  }

  visit(graph.root);
  return result;
}

/**
 * Simulate the actual React render pass using the new approach.
 *
 * computeMatchingIds() is called once via useMemo, then each TreeItem
 * does O(1) Set.has() instead of walking its subtree.
 */
function filterWithPrecomputed(
  graph: CodeGraph,
  query: string
): number {
  const matchingIds = computeMatchingIds(graph, query);
  let visibleCount = 0;

  function renderTreeItem(nodeId: string): void {
    // O(1) Set.has() replaces O(subtree) recursive walk
    if (!matchingIds.has(nodeId)) return;

    visibleCount++;

    const node = graph.nodes[nodeId];
    if (node) {
      for (const childId of node.children) {
        renderTreeItem(childId);
      }
    }
  }

  const root = graph.nodes[graph.root];
  if (root) {
    for (const childId of root.children) {
      renderTreeItem(childId);
    }
  }

  return visibleCount;
}

// ── Runner ──────────────────────────────────────────────────────────

interface BenchResult {
  name: string;
  nodes: number;
  query: string;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  opsPerSec: number;
}

function runBench(fn: () => unknown, warmup: number, iters: number): number[] {
  for (let i = 0; i < warmup; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times;
}

function stats(times: number[]) {
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

const NODE_COUNTS = [100, 500, 1_000, 5_000, 10_000];
const WARMUP = 50;
const ITERS = 200;

// Search queries: broad match (many hits), narrow match (few hits), no match
const QUERIES = [
  { label: "broad", query: "e" },         // matches many symbol names
  { label: "narrow", query: "handleReq" }, // matches few symbols
  { label: "miss", query: "zzzzzzz" },     // matches nothing
];

console.log("═══════════════════════════════════════════════════════════════");
console.log("  PR #3 Benchmark: sidebar search filtering");
console.log("  Per-node recursive matchesQuery() (main) vs");
console.log("  Single-pass computeMatchingIds() + Set.has() (PR branch)");
console.log(`  ${WARMUP} warmup iterations, ${ITERS} measured iterations`);
console.log("═══════════════════════════════════════════════════════════════\n");

const results: BenchResult[] = [];

for (const nodeCount of NODE_COUNTS) {
  const graph = generateGraph(nodeCount);
  const actualNodeCount = Object.keys(graph.nodes).length;
  const depth = measureDepth(graph);

  console.log(`\n${"─".repeat(61)}`);
  console.log(`  ${actualNodeCount} nodes (target ${nodeCount}), depth ${depth}`);
  console.log(`${"─".repeat(61)}`);

  for (const { label, query } of QUERIES) {
    // Baseline: per-node recursive matchesQuery
    const recursiveTimes = runBench(
      () => filterWithRecursive(graph, query),
      WARMUP,
      ITERS
    );
    const recursiveS = stats(recursiveTimes);

    // Optimized: single-pass precompute + Set.has
    const precomputedTimes = runBench(
      () => filterWithPrecomputed(graph, query),
      WARMUP,
      ITERS
    );
    const precomputedS = stats(precomputedTimes);

    const speedup = recursiveS.median / precomputedS.median;

    // Count matches for context
    const matchCount = filterWithPrecomputed(graph, query);

    console.log(`\n  query="${query}" (${label}, ${matchCount} matches):`);
    console.log(
      `    Recursive     median=${formatMs(recursiveS.median)}  p95=${formatMs(recursiveS.p95)}  min=${formatMs(recursiveS.min)}`
    );
    console.log(
      `    Precomputed   median=${formatMs(precomputedS.median)}  p95=${formatMs(precomputedS.p95)}  min=${formatMs(precomputedS.min)}`
    );
    console.log(`    Speedup:      ${speedup.toFixed(1)}x`);

    results.push({
      name: "Recursive",
      nodes: actualNodeCount,
      query: label,
      medianMs: recursiveS.median,
      meanMs: recursiveS.mean,
      minMs: recursiveS.min,
      maxMs: recursiveS.max,
      p95Ms: recursiveS.p95,
      opsPerSec: 1000 / recursiveS.median,
    });
    results.push({
      name: "Precomputed",
      nodes: actualNodeCount,
      query: label,
      medianMs: precomputedS.median,
      meanMs: precomputedS.mean,
      minMs: precomputedS.min,
      maxMs: precomputedS.max,
      p95Ms: precomputedS.p95,
      opsPerSec: 1000 / precomputedS.median,
    });
  }
}

// ── Summary table ───────────────────────────────────────────────────

console.log(`\n${"═".repeat(61)}`);
console.log("  Summary: median speedup by scale and query type");
console.log(`${"═".repeat(61)}`);
console.log(
  "  Nodes   │ Broad (\"e\")  │ Narrow       │ Miss         │ Avg"
);
console.log(
  "  ────────┼──────────────┼──────────────┼──────────────┼──────────"
);

for (const nodeCount of NODE_COUNTS) {
  // Find the actual node count used for this target
  const nodeResults = results.filter((r) => {
    // Match by approximate target
    return Math.abs(r.nodes - nodeCount) < nodeCount * 0.5;
  });
  if (nodeResults.length === 0) continue;

  const actualNodes = nodeResults[0].nodes;
  const speedups: number[] = [];

  let line = `  ${String(actualNodes).padStart(6)}  │`;
  for (const queryLabel of ["broad", "narrow", "miss"]) {
    const rec = nodeResults.find((r) => r.name === "Recursive" && r.query === queryLabel);
    const pre = nodeResults.find((r) => r.name === "Precomputed" && r.query === queryLabel);
    if (rec && pre) {
      const speedup = rec.medianMs / pre.medianMs;
      speedups.push(speedup);
      line += ` ${speedup.toFixed(1).padStart(10)}x │`;
    } else {
      line += `         N/A │`;
    }
  }

  const avg = speedups.length > 0
    ? speedups.reduce((a, b) => a + b, 0) / speedups.length
    : 0;
  line += ` ${avg.toFixed(1).padStart(6)}x`;
  console.log(line);
}

console.log(
  "\nNote: Recursive approach calls matchesQuery() per node during render,"
);
console.log(
  "each walking the subtree — O(N*D) total. Precomputed approach walks the"
);
console.log(
  "tree once — O(N) — then does O(1) Set.has() per node during render.\n"
);

// ── Bench 2: Repeated renders (useMemo caching simulation) ──────────
//
// In React, after the initial search, subsequent re-renders (expand/collapse,
// hover, selection) reuse the memoized Set. The old approach re-runs
// matchesQuery for every node on every render.

console.log(`\n${"═".repeat(61)}`);
console.log("  Repeated renders: simulating useMemo cache benefit");
console.log("  (expand/collapse/hover triggers re-render with same query)");
console.log(`${"═".repeat(61)}`);

const RE_RENDER_COUNTS = [5, 10, 20];
const REPEAT_QUERY = "handleReq";

for (const nodeCount of [1_000, 5_000, 10_000]) {
  const graph = generateGraph(nodeCount);
  const actualNodeCount = Object.keys(graph.nodes).length;
  const depth = measureDepth(graph);

  for (const rerenders of RE_RENDER_COUNTS) {
    // Old: matchesQuery re-runs on every render
    const oldTimes = runBench(
      () => {
        for (let r = 0; r < rerenders; r++) {
          filterWithRecursive(graph, REPEAT_QUERY);
        }
      },
      WARMUP,
      ITERS
    );
    const oldS = stats(oldTimes);

    // New: computeMatchingIds runs once (cached), subsequent renders use Set.has only
    const newTimes = runBench(
      () => {
        // First render: full computation
        const matchingIds = computeMatchingIds(graph, REPEAT_QUERY);

        // Subsequent renders: only Set.has() traversal (useMemo returns cached Set)
        for (let r = 0; r < rerenders; r++) {
          let count = 0;
          function renderCached(nodeId: string): void {
            if (!matchingIds.has(nodeId)) return;
            count++;
            const node = graph.nodes[nodeId];
            if (node) {
              for (const childId of node.children) {
                renderCached(childId);
              }
            }
          }
          const root = graph.nodes[graph.root];
          if (root) {
            for (const childId of root.children) {
              renderCached(childId);
            }
          }
        }
      },
      WARMUP,
      ITERS
    );
    const newS = stats(newTimes);

    const speedup = oldS.median / newS.median;
    console.log(
      `  ${actualNodeCount} nodes, ${rerenders} re-renders: ` +
      `old=${formatMs(oldS.median)}  new=${formatMs(newS.median)}  → ${speedup.toFixed(1)}x`
    );
  }
}

console.log(
  "\nNote: With useMemo, computeMatchingIds runs once when searchQuery changes."
);
console.log(
  "Subsequent re-renders (hover, expand, select) skip recomputation and only"
);
console.log(
  "do O(1) Set.has() per node. The old approach re-walks subtrees every time.\n"
);

// ── Correctness check ───────────────────────────────────────────────

const testGraph = generateGraph(200);

for (const { label, query } of QUERIES) {
  const recursiveVisible = filterWithRecursive(testGraph, query);
  const precomputedVisible = filterWithPrecomputed(testGraph, query);
  const match = recursiveVisible === precomputedVisible;
  console.log(
    `Correctness (${label} "${query}"): recursive=${recursiveVisible}, precomputed=${precomputedVisible} ${match ? "PASS ✓" : "FAIL ✗"}`
  );
}
