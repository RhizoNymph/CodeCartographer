/**
 * Edge-routing benchmark for the canvas redraw path.
 *
 *   cd packages/app && node benchmarks/edgeRouting.bench.ts
 *   node benchmarks/edgeRouting.bench.ts --json out.json --sizes 300x200,800x500
 *
 * NOT part of the `node --test "tests/*.test.ts"` glob: it is a stopwatch, not
 * an assertion, and it takes minutes at the larger sizes.
 *
 * # What it measures
 *
 * The per-redraw cost of turning laid-out edges into routed polylines. Three
 * scenarios, each on the same synthetic layout:
 *
 * 1. `full_scan_routing` -- obstacles collected PER EDGE by scanning every
 *    visible node, then `routePolylineAroundObstacles` with crossing-aware
 *    scoring. This is what the renderer did before the obstacle index, and it is
 *    reimplemented HERE rather than imported, so it is byte-identical on every
 *    branch and can serve as the common yardstick.
 * 2. `indexed_routing` -- obstacles indexed ONCE per redraw and queried per edge
 *    via `src/canvas/layout/obstacleIndex.ts`. That module only exists on the
 *    perf branch; where it is missing this scenario is reported as `skipped`.
 * 3. `shipped_redraw` -- what the branch under test actually does at this size,
 *    budget gate included. `src/canvas/layout/edgeRoutingBudget.ts` also only
 *    exists on the perf branch; without it the scenario falls back to
 *    "route everything, crossing-aware", which is the older shipped behaviour.
 *
 * # Comparing branches
 *
 * - `full_scan_routing` is comparable across branches directly, and mostly
 *   exists to prove the two runs are on comparable hardware/runtime: it should
 *   come out roughly EQUAL. A large gap there means the environments differ and
 *   the rest of the numbers should be distrusted.
 * - `indexed_routing` vs `full_scan_routing` (same run) is the obstacle-index
 *   win, measurable on the perf branch alone.
 * - `shipped_redraw` old vs new is the user-visible number, and includes the
 *   budget gate skipping routing entirely above its thresholds.
 *
 * Imports use explicit `.ts` specifiers so the module chain loads under plain
 * `node` (see tsconfig `allowImportingTsExtensions`).
 */

import {
  routePolylineAroundObstacles,
  type NodeBox,
  type Point,
} from "../src/canvas/layout/edgeGeometry.ts";

/**
 * Mirrors `OBSTACLE_QUERY_MARGIN` in `src/canvas/layout/routingConstants.ts`.
 * Deliberately a literal, not an import: this file must stay byte-comparable
 * across branches where that module does not exist.
 */
const OBSTACLE_QUERY_MARGIN = 160;

/** No-reference-polylines sentinel, matching the renderer's shared constant. */
const NO_REFERENCE_POLYLINES: Point[][] = [];

// ---------------------------------------------------------------------------
// Optional modules (perf branch only)
// ---------------------------------------------------------------------------

interface ObstacleIndexModule {
  ObstacleIndex: new (entries: readonly unknown[]) => {
    readonly size: number;
    queryForPolyline(
      points: readonly Point[],
      margin: number,
      excludeOwnerA?: string | null,
      excludeOwnerB?: string | null
    ): NodeBox[];
  };
  obstacleEntry: (ownerId: string, box: NodeBox) => unknown;
}

interface BudgetModule {
  resolveEdgeRoutingMode: (input: {
    renderedEdges: number;
    visibleNodes: number;
    edgesVisible?: boolean;
  }) => "full" | "obstacles" | "none";
  routesAroundObstacles: (mode: string) => boolean;
  scoresEdgeCrossings: (mode: string) => boolean;
}

async function loadOptional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic synthetic layout
// ---------------------------------------------------------------------------

/** SplitMix32: same layout on every run and every branch. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  };
}

interface BenchNode {
  id: string;
  box: NodeBox;
  labelBox: NodeBox;
}

interface BenchEdge {
  source: string;
  target: string;
  points: Point[];
}

interface Layout {
  nodes: BenchNode[];
  nodesById: Map<string, BenchNode>;
  edges: BenchEdge[];
}

/**
 * A grid of boxes with edges between randomly chosen pairs, routed as the
 * two-bend orthogonal polylines ELK produces. Edge endpoints are anchored on
 * the box borders, so the polylines start out legal and the routing pass has to
 * do real detour work where boxes sit in between.
 */
function buildLayout(nodeCount: number, edgeCount: number, seed = 20240611): Layout {
  const rng = makeRng(seed);
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeCount)));
  const cellW = 260;
  const cellH = 150;

  const nodes: BenchNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * cellW + 20 + Math.floor(rng() * 20);
    const y = row * cellH + 20 + Math.floor(rng() * 20);
    const width = 140 + Math.floor(rng() * 60);
    const height = 48 + Math.floor(rng() * 24);
    nodes.push({
      id: `n${i}`,
      box: { x, y, width, height },
      labelBox: { x: x + 4, y: y - 18, width: width - 8, height: 14 },
    });
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const edges: BenchEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = nodes[Math.floor(rng() * nodes.length)];
    let b = nodes[Math.floor(rng() * nodes.length)];
    if (a === b) {
      b = nodes[(nodes.indexOf(a) + 1) % nodes.length];
    }
    const start: Point = {
      x: a.box.x + a.box.width,
      y: a.box.y + a.box.height / 2,
    };
    const end: Point = { x: b.box.x, y: b.box.y + b.box.height / 2 };
    const midX = (start.x + end.x) / 2;
    edges.push({
      source: a.id,
      target: b.id,
      points: [
        start,
        { x: midX, y: start.y },
        { x: midX, y: end.y },
        end,
      ],
    });
  }

  return { nodes, nodesById, edges };
}

function boxCenter(box: NodeBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function boxContainsPoint(box: NodeBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: full-scan obstacle collection (the pre-index renderer)
// ---------------------------------------------------------------------------

function fullScanObstacles(layout: Layout, edge: BenchEdge): NodeBox[] {
  const source = layout.nodesById.get(edge.source)!;
  const target = layout.nodesById.get(edge.target)!;
  const sourceCenter = boxCenter(source.box);
  const targetCenter = boxCenter(target.box);
  const obstacles: NodeBox[] = [];

  for (const node of layout.nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;

    if (
      !boxContainsPoint(node.labelBox, sourceCenter) &&
      !boxContainsPoint(node.labelBox, targetCenter)
    ) {
      obstacles.push(node.labelBox);
    }
    if (
      !boxContainsPoint(node.box, sourceCenter) &&
      !boxContainsPoint(node.box, targetCenter)
    ) {
      obstacles.push(node.box);
    }
  }

  return obstacles;
}

function routeFullScan(layout: Layout, scoreCrossings: boolean): number {
  const routed: Point[][] = [];
  let points = 0;
  for (const edge of layout.edges) {
    const result = routePolylineAroundObstacles(
      edge.points,
      fullScanObstacles(layout, edge),
      scoreCrossings ? routed : NO_REFERENCE_POLYLINES
    );
    if (scoreCrossings) routed.push(result);
    points += result.length;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Scenario 2: indexed obstacle collection (perf branch)
// ---------------------------------------------------------------------------

function routeIndexed(
  layout: Layout,
  mod: ObstacleIndexModule,
  scoreCrossings: boolean
): number {
  const entries = layout.nodes.flatMap((node) => [
    mod.obstacleEntry(node.id, node.labelBox),
    mod.obstacleEntry(node.id, node.box),
  ]);
  const index = new mod.ObstacleIndex(entries);

  const routed: Point[][] = [];
  let points = 0;
  for (const edge of layout.edges) {
    const source = layout.nodesById.get(edge.source)!;
    const target = layout.nodesById.get(edge.target)!;
    const sourceCenter = boxCenter(source.box);
    const targetCenter = boxCenter(target.box);

    const candidates = index.queryForPolyline(
      edge.points,
      OBSTACLE_QUERY_MARGIN,
      edge.source,
      edge.target
    );
    const obstacles: NodeBox[] = [];
    for (const box of candidates) {
      if (boxContainsPoint(box, sourceCenter) || boxContainsPoint(box, targetCenter)) {
        continue;
      }
      obstacles.push(box);
    }

    const result = routePolylineAroundObstacles(
      edge.points,
      obstacles,
      scoreCrossings ? routed : NO_REFERENCE_POLYLINES
    );
    if (scoreCrossings) routed.push(result);
    points += result.length;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Timing {
  name: string;
  status: "ok" | "skipped";
  reps?: number;
  meanMs?: number;
  minMs?: number;
  totalMs?: number;
  note?: string;
}

/**
 * Run `fn` up to `reps` times, stopping early once `budgetMs` of wall time is
 * spent. The heavy scenarios take tens of seconds per rep; a fixed rep count
 * would make the suite unusable at the top size.
 */
function time(name: string, reps: number, budgetMs: number, fn: () => unknown): Timing {
  const samples: number[] = [];
  const deadline = performance.now() + budgetMs;

  // One untimed warm-up so JIT tiering does not land entirely in sample 1.
  fn();

  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
    if (performance.now() > deadline) break;
  }

  const total = samples.reduce((a, b) => a + b, 0);
  return {
    name,
    status: "ok",
    reps: samples.length,
    meanMs: total / samples.length,
    minMs: Math.min(...samples),
    totalMs: total,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SizeSpec {
  nodes: number;
  edges: number;
}

function parseSizes(raw: string | undefined): SizeSpec[] {
  if (!raw) {
    return [
      { nodes: 300, edges: 200 },
      { nodes: 800, edges: 500 },
      { nodes: 1500, edges: 1200 },
    ];
  }
  return raw.split(",").map((chunk) => {
    const [nodes, edges] = chunk.split("x").map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(nodes) || !Number.isFinite(edges)) {
      throw new Error(`bad --sizes entry: ${chunk} (expected e.g. 800x500)`);
    }
    return { nodes, edges };
  });
}

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const sizes = parseSizes(flag("sizes"));
  const label = flag("label") ?? "unlabelled";
  const reps = Number.parseInt(flag("reps") ?? "5", 10);
  const budgetMs = Number.parseInt(flag("budget-ms") ?? "20000", 10);

  const obstacleMod = await loadOptional<ObstacleIndexModule>(
    "../src/canvas/layout/obstacleIndex.ts"
  );
  // The budget module moved renderers/ -> layout/ when the routing pipeline was
  // consolidated there; both paths are probed so a run on an older branch still
  // finds it and stays comparable.
  const budgetMod =
    (await loadOptional<BudgetModule>("../src/canvas/layout/edgeRoutingBudget.ts")) ??
    (await loadOptional<BudgetModule>("../src/canvas/renderers/edgeRoutingBudget.ts"));

  process.stderr.write(
    `[edgeRouting.bench] label=${label} obstacleIndex=${obstacleMod ? "present" : "absent"} ` +
      `routingBudget=${budgetMod ? "present" : "absent"}\n`
  );

  const results: Array<{ nodes: number; edges: number; timings: Timing[] }> = [];

  for (const size of sizes) {
    const layout = buildLayout(size.nodes, size.edges);
    const timings: Timing[] = [];

    timings.push(
      time("full_scan_routing", reps, budgetMs, () => routeFullScan(layout, true))
    );

    if (obstacleMod) {
      timings.push(
        time("indexed_routing", reps, budgetMs, () =>
          routeIndexed(layout, obstacleMod, true)
        )
      );
    } else {
      timings.push({
        name: "indexed_routing",
        status: "skipped",
        note: "src/canvas/layout/obstacleIndex.ts does not exist on this branch",
      });
    }

    // What this branch actually does for a redraw of this size.
    if (budgetMod && obstacleMod) {
      const mode = budgetMod.resolveEdgeRoutingMode({
        renderedEdges: size.edges,
        visibleNodes: size.nodes,
      });
      const scoreCrossings = budgetMod.scoresEdgeCrossings(mode);
      const routes = budgetMod.routesAroundObstacles(mode);
      const timing = time("shipped_redraw", reps, budgetMs, () =>
        routes ? routeIndexed(layout, obstacleMod, scoreCrossings) : 0
      );
      timing.note = `budget mode=${mode}`;
      timings.push(timing);
    } else {
      const timing = time("shipped_redraw", reps, budgetMs, () =>
        routeFullScan(layout, true)
      );
      timing.note = "no routing budget on this branch: always full-scan, crossing-aware";
      timings.push(timing);
    }

    for (const t of timings) {
      process.stderr.write(
        `  ${size.nodes}n/${size.edges}e ${t.name.padEnd(18)} ` +
          (t.status === "ok"
            ? `${t.meanMs!.toFixed(1)}ms mean over ${t.reps} reps${t.note ? ` (${t.note})` : ""}\n`
            : `skipped (${t.note})\n`)
      );
    }

    results.push({ nodes: size.nodes, edges: size.edges, timings });
  }

  const report = {
    label,
    runtime: process.version,
    obstacleIndexAvailable: Boolean(obstacleMod),
    routingBudgetAvailable: Boolean(budgetMod),
    reps,
    sizes: results,
  };

  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  const out = flag("json");
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, rendered);
  }
  process.stdout.write(rendered);
}

main().catch((error: unknown) => {
  process.stderr.write(`edgeRouting.bench failed: ${String(error)}\n`);
  process.exitCode = 1;
});
