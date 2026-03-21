/**
 * Benchmark: PR #2 viewport/renderer optimizations
 *
 * Measures three improvements from the PR:
 *   1. Minimap caching — full rebuild every call vs cached node layer + viewport-only redraw
 *   2. Viewport event coalescing — per-event handler vs RAF-batched (one per frame)
 *   3. CullingManager removal — overhead of unused RBush upsert() calls
 *
 * Usage: npx tsx packages/app/benches/viewportRenderer.bench.ts
 */

import { performance } from "node:perf_hooks";

// ── Types (mirrored from the app) ───────────────────────────────────

interface LayoutNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutResult {
  nodes: Record<string, LayoutNodePosition>;
}

interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Data generators ─────────────────────────────────────────────────

function generateLayout(nodeCount: number): LayoutResult {
  const nodes: Record<string, LayoutNodePosition> = {};
  const cols = Math.ceil(Math.sqrt(nodeCount));
  for (let i = 0; i < nodeCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodes[`node_${i}`] = {
      x: col * 200 + Math.random() * 40,
      y: row * 120 + Math.random() * 20,
      width: 140 + Math.random() * 60,
      height: 60 + Math.random() * 40,
    };
  }
  return { nodes };
}

function generateViewportBounds(layout: LayoutResult): ViewportBounds {
  const positions = Object.values(layout.nodes);
  const centerX =
    positions.reduce((s, p) => s + p.x + p.width / 2, 0) / positions.length;
  const centerY =
    positions.reduce((s, p) => s + p.y + p.height / 2, 0) / positions.length;
  return { x: centerX - 400, y: centerY - 300, width: 800, height: 600 };
}

/** Simulate panning: return a sequence of slightly shifted viewport bounds */
function generatePanSequence(
  base: ViewportBounds,
  steps: number
): ViewportBounds[] {
  const seq: ViewportBounds[] = [];
  for (let i = 0; i < steps; i++) {
    seq.push({
      x: base.x + i * 3,
      y: base.y + i * 1.5,
      width: base.width,
      height: base.height,
    });
  }
  return seq;
}

// ── Minimap implementations ─────────────────────────────────────────

const MM_WIDTH = 150;
const MM_HEIGHT = 100;
const CONTAINER_W = 1280;
const CONTAINER_H = 800;

interface MinimapGeometry {
  mmX: number;
  mmY: number;
  mmWidth: number;
  mmHeight: number;
  minX: number;
  minY: number;
  mmScale: number;
}

function getMinimapGeometry(layout: LayoutResult): MinimapGeometry | null {
  const positions = Object.values(layout.nodes);
  if (positions.length === 0) return null;

  const mmX = CONTAINER_W - MM_WIDTH - 10;
  const mmY = CONTAINER_H - MM_HEIGHT - 10;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of positions) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  }

  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const scaleX = (MM_WIDTH - 8) / worldW;
  const scaleY = (MM_HEIGHT - 8) / worldH;
  const mmScale = Math.min(scaleX, scaleY);

  return { mmX, mmY, mmWidth: MM_WIDTH, mmHeight: MM_HEIGHT, minX, minY, mmScale };
}

/**
 * BEFORE (main): Full minimap rebuild every call.
 * Recomputes bounds, iterates all nodes, draws background + nodes + viewport rect.
 * Returns an array of drawing commands to simulate GPU work (same cost as Graphics calls).
 */
function updateMinimapFull(
  layout: LayoutResult,
  vp: ViewportBounds
): number[] {
  const positions = Object.values(layout.nodes);
  if (positions.length === 0) return [];

  const mmX = CONTAINER_W - MM_WIDTH - 10;
  const mmY = CONTAINER_H - MM_HEIGHT - 10;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of positions) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  }

  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const scaleX = (MM_WIDTH - 8) / worldW;
  const scaleY = (MM_HEIGHT - 8) / worldH;
  const mmScale = Math.min(scaleX, scaleY);

  // Simulate draw commands (background)
  const cmds: number[] = [mmX, mmY, MM_WIDTH, MM_HEIGHT];

  // Simulate drawing every node (this is the expensive part)
  for (const pos of positions) {
    const rx = mmX + 4 + (pos.x - minX) * mmScale;
    const ry = mmY + 4 + (pos.y - minY) * mmScale;
    const rw = Math.max(pos.width * mmScale, 2);
    const rh = Math.max(pos.height * mmScale, 1);
    cmds.push(rx, ry, rw, rh);
  }

  // Simulate drawing viewport rect
  const vpRx = mmX + 4 + (vp.x - minX) * mmScale;
  const vpRy = mmY + 4 + (vp.y - minY) * mmScale;
  const vpRw = vp.width * mmScale;
  const vpRh = vp.height * mmScale;
  cmds.push(vpRx, vpRy, vpRw, vpRh);

  return cmds;
}

/**
 * AFTER (PR #2): Cached minimap — only redraws viewport rectangle.
 * The node layer is prebuilt and skipped if the layout hasn't changed.
 */
class CachedMinimap {
  private cachedLayout: LayoutResult | null = null;
  private cachedNodeCmds: number[] | null = null;
  private cachedGeo: MinimapGeometry | null = null;

  /** Called on every viewport change. Skips node rebuild if layout is same. */
  update(layout: LayoutResult, vp: ViewportBounds): number[] {
    // Rebuild node layer only when layout reference changes
    if (this.cachedLayout !== layout) {
      this.cachedLayout = layout;
      this.cachedGeo = getMinimapGeometry(layout);
      if (!this.cachedGeo) {
        this.cachedNodeCmds = null;
        return [];
      }

      const geo = this.cachedGeo;
      const cmds: number[] = [geo.mmX, geo.mmY, geo.mmWidth, geo.mmHeight];
      for (const pos of Object.values(layout.nodes)) {
        const rx = geo.mmX + 4 + (pos.x - geo.minX) * geo.mmScale;
        const ry = geo.mmY + 4 + (pos.y - geo.minY) * geo.mmScale;
        const rw = Math.max(pos.width * geo.mmScale, 2);
        const rh = Math.max(pos.height * geo.mmScale, 1);
        cmds.push(rx, ry, rw, rh);
      }
      this.cachedNodeCmds = cmds;
    }

    if (!this.cachedGeo) return [];

    // Only compute viewport rectangle overlay (cheap)
    const geo = this.cachedGeo;
    const vpRx = geo.mmX + 4 + (vp.x - geo.minX) * geo.mmScale;
    const vpRy = geo.mmY + 4 + (vp.y - geo.minY) * geo.mmScale;
    const vpRw = vp.width * geo.mmScale;
    const vpRh = vp.height * geo.mmScale;

    return [vpRx, vpRy, vpRw, vpRh];
  }
}

// ── Viewport event coalescing ───────────────────────────────────────

/**
 * BEFORE (main): handler fires once per event — no batching.
 * Simulates N calls to onViewportChanged (each does LOD check + minimap update).
 */
function handleEventsUnbatched(
  layout: LayoutResult,
  events: ViewportBounds[],
  handler: (layout: LayoutResult, vp: ViewportBounds) => void
): number {
  let callCount = 0;
  for (const vp of events) {
    handler(layout, vp);
    callCount++;
  }
  return callCount;
}

/**
 * AFTER (PR #2): RAF-coalesced — only the last event per frame fires.
 * In real code, rAF collapses ~4-8 move events into one call per 16ms frame.
 * We simulate this by processing only every Nth event (frame coalescing ratio).
 */
function handleEventsCoalesced(
  layout: LayoutResult,
  events: ViewportBounds[],
  handler: (layout: LayoutResult, vp: ViewportBounds) => void,
  coalesceRatio: number
): number {
  let callCount = 0;
  for (let i = 0; i < events.length; i++) {
    // Only process the last event in each coalesced batch
    if ((i + 1) % coalesceRatio === 0 || i === events.length - 1) {
      handler(layout, events[i]);
      callCount++;
    }
  }
  return callCount;
}

// ── CullingManager simulation ───────────────────────────────────────

/**
 * Simulates RBush-like spatial index overhead.
 * The PR removes CullingManager.upsert() calls during renderFromLayout and
 * node position updates. We measure the overhead of maintaining a spatial index.
 */
class SimpleSpatialIndex {
  private items: Map<
    string,
    { id: string; minX: number; minY: number; maxX: number; maxY: number }
  > = new Map();

  upsert(id: string, x: number, y: number, w: number, h: number): void {
    this.items.set(id, {
      id,
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h,
    });
  }

  clear(): void {
    this.items.clear();
  }
}

// ── Benchmark runner ────────────────────────────────────────────────

interface BenchResult {
  name: string;
  variant: string;
  nodes: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  p95: number;
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

const NODE_COUNTS = [100, 500, 1_000, 5_000];
const PAN_STEPS = 120; // ~2 seconds of pan at 60fps
const COALESCE_RATIO = 6; // typical move events per frame during pan
const WARMUP = 30;
const ITERS = 150;

console.log("═══════════════════════════════════════════════════════════════");
console.log("  PR #2 Benchmark: viewport/renderer optimizations");
console.log("  Full minimap rebuild vs cached + viewport-only redraw");
console.log("  Unbatched viewport events vs RAF-coalesced");
console.log("  CullingManager (RBush) upsert overhead");
console.log(`  ${WARMUP} warmup, ${ITERS} measured iterations`);
console.log("═══════════════════════════════════════════════════════════════\n");

const allResults: BenchResult[] = [];

for (const nodeCount of NODE_COUNTS) {
  const layout = generateLayout(nodeCount);
  const baseVp = generateViewportBounds(layout);
  const panSequence = generatePanSequence(baseVp, PAN_STEPS);

  console.log(`\n${"─".repeat(61)}`);
  console.log(`  ${nodeCount} nodes, ${PAN_STEPS} pan events (coalesce ratio ${COALESCE_RATIO}:1)`);
  console.log(`${"─".repeat(61)}`);

  // ── Bench 1: Minimap full rebuild vs cached (per pan sequence) ──

  // BEFORE: Full rebuild on every viewport change
  const fullTimes = runBench(
    () => {
      for (const vp of panSequence) {
        updateMinimapFull(layout, vp);
      }
    },
    WARMUP,
    ITERS
  );
  const fullS = stats(fullTimes);

  // AFTER: Cached — node layer built once, only viewport rect redrawn
  const cachedTimes = runBench(
    () => {
      const mm = new CachedMinimap();
      for (const vp of panSequence) {
        mm.update(layout, vp);
      }
    },
    WARMUP,
    ITERS
  );
  const cachedS = stats(cachedTimes);

  const mmSpeedup = fullS.median / cachedS.median;
  console.log(`\n  Minimap update (${PAN_STEPS} calls during pan):`);
  console.log(
    `    Full rebuild  median=${formatMs(fullS.median)}  p95=${formatMs(fullS.p95)}`
  );
  console.log(
    `    Cached        median=${formatMs(cachedS.median)}  p95=${formatMs(cachedS.p95)}`
  );
  console.log(`    Speedup:      ${mmSpeedup.toFixed(1)}x`);

  allResults.push(
    { name: "Minimap", variant: "Full rebuild", nodes: nodeCount, ...fullS },
    { name: "Minimap", variant: "Cached", nodes: nodeCount, ...cachedS }
  );

  // ── Bench 2: Viewport event coalescing ────────────────────────

  // Handler does real work: bounds + minimap (simulated)
  const heavyHandler = (l: LayoutResult, vp: ViewportBounds) => {
    updateMinimapFull(l, vp);
  };

  const unbatchedTimes = runBench(
    () => handleEventsUnbatched(layout, panSequence, heavyHandler),
    WARMUP,
    ITERS
  );
  const unbatchedS = stats(unbatchedTimes);

  const coalescedTimes = runBench(
    () =>
      handleEventsCoalesced(layout, panSequence, heavyHandler, COALESCE_RATIO),
    WARMUP,
    ITERS
  );
  const coalescedS = stats(coalescedTimes);

  const evSpeedup = unbatchedS.median / coalescedS.median;
  console.log(`\n  Viewport event handling (${PAN_STEPS} move events):`);
  console.log(
    `    Every event   median=${formatMs(unbatchedS.median)}  p95=${formatMs(unbatchedS.p95)}`
  );
  console.log(
    `    RAF coalesced  median=${formatMs(coalescedS.median)}  p95=${formatMs(coalescedS.p95)}`
  );
  console.log(`    Speedup:       ${evSpeedup.toFixed(1)}x (${PAN_STEPS} events → ${Math.ceil(PAN_STEPS / COALESCE_RATIO)} handler calls)`);

  allResults.push(
    { name: "Events", variant: "Every event", nodes: nodeCount, ...unbatchedS },
    { name: "Events", variant: "RAF coalesced", nodes: nodeCount, ...coalescedS }
  );

  // ── Bench 3: CullingManager overhead ──────────────────────────

  const positions = Object.entries(layout.nodes);

  // WITH CullingManager upsert (main — wasted work)
  const withCullingTimes = runBench(
    () => {
      const cm = new SimpleSpatialIndex();
      cm.clear();
      for (const [id, pos] of positions) {
        cm.upsert(id, pos.x, pos.y, pos.width, pos.height);
      }
    },
    WARMUP,
    ITERS
  );
  const withCS = stats(withCullingTimes);

  // WITHOUT CullingManager (PR — no overhead)
  const withoutCullingTimes = runBench(
    () => {
      // PR removes all CullingManager calls — pure iteration baseline
      for (const [, pos] of positions) {
        // Just access the data (node rendering loop still exists)
        void pos.x;
        void pos.y;
      }
    },
    WARMUP,
    ITERS
  );
  const withoutCS = stats(withoutCullingTimes);

  const cmSpeedup = withCS.median / withoutCS.median;
  console.log(`\n  CullingManager overhead (${nodeCount} upserts):`);
  console.log(
    `    With upsert   median=${formatMs(withCS.median)}  p95=${formatMs(withCS.p95)}`
  );
  console.log(
    `    Without       median=${formatMs(withoutCS.median)}  p95=${formatMs(withoutCS.p95)}`
  );
  console.log(`    Overhead:     ${cmSpeedup.toFixed(1)}x`);

  allResults.push(
    { name: "Culling", variant: "With upsert", nodes: nodeCount, ...withCS },
    { name: "Culling", variant: "Without", nodes: nodeCount, ...withoutCS }
  );
}

// ── Combined summary ────────────────────────────────────────────────

console.log(`\n${"═".repeat(61)}`);
console.log("  Combined improvement estimate per pan gesture");
console.log(`${"═".repeat(61)}`);
console.log(
  "  Nodes  │ Minimap cache │ RAF coalesce │ Culling removal │ Combined"
);
console.log(
  "  ───────┼───────────────┼──────────────┼─────────────────┼──────────"
);

for (const nodeCount of NODE_COUNTS) {
  const mm = allResults.filter((r) => r.name === "Minimap" && r.nodes === nodeCount);
  const ev = allResults.filter((r) => r.name === "Events" && r.nodes === nodeCount);
  const cm = allResults.filter((r) => r.name === "Culling" && r.nodes === nodeCount);

  const mmSpeedup = mm[0].median / mm[1].median;
  const evSpeedup = ev[0].median / ev[1].median;
  const cmSaved = cm[0].median - cm[1].median;

  // Combined: the minimap cache and RAF coalesce compound
  // (cached minimap is faster per call AND called fewer times)
  const beforeTotal = ev[0].median + cm[0].median;
  const afterTotal = ev[1].median * (mm[1].median / mm[0].median) + cm[1].median;
  const combined = beforeTotal / afterTotal;

  console.log(
    `  ${String(nodeCount).padStart(5)}  │ ${mmSpeedup.toFixed(1).padStart(11)}x │ ${evSpeedup.toFixed(1).padStart(10)}x │ ${formatMs(cmSaved).padStart(13)} saved │ ${combined.toFixed(1).padStart(6)}x`
  );
}

console.log(
  "\nNote: Minimap benchmark uses simulated draw commands (array pushes) rather"
);
console.log(
  "than real PIXI Graphics calls. Actual GPU-side improvement will be larger"
);
console.log(
  "since destroying + recreating WebGL Graphics objects is more expensive than"
);
console.log("array allocations.\n");

// ── Correctness check ───────────────────────────────────────────────

const testLayout = generateLayout(50);
const testVp = generateViewportBounds(testLayout);
const fullResult = updateMinimapFull(testLayout, testVp);
const cachedMm = new CachedMinimap();
cachedMm.update(testLayout, testVp); // first call builds cache
const cachedVpResult = cachedMm.update(testLayout, testVp); // second call uses cache

// The cached version on second call should only produce viewport rect coords
// (4 values) vs full rebuild which produces bg + all nodes + viewport rect
const fullHasAllNodes = fullResult.length === 4 + 50 * 4 + 4; // bg + 50 nodes + vp
const cachedIsViewportOnly = cachedVpResult.length === 4; // vp rect only

console.log(
  `Correctness: full rebuild ${fullResult.length} draw cmds (expected ${4 + 50 * 4 + 4}): ${fullHasAllNodes ? "PASS" : "FAIL"}`
);
console.log(
  `Correctness: cached call ${cachedVpResult.length} draw cmds (expected 4): ${cachedIsViewportOnly ? "PASS" : "FAIL"}`
);
