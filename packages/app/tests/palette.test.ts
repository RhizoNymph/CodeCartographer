import assert from "node:assert/strict";
import test from "node:test";

import type { BlockKind, EdgeKind } from "../src/api/types.ts";
import { BLOCK_COLORS, EDGE_COLORS, NODE_COLORS } from "../src/api/types.ts";

/**
 * Palette invariants.
 *
 * The palette has one job: colour must be trustworthy as a category signal.
 * That means (a) edges use a small number of hues a user can hold in working
 * memory, (b) a hue means exactly one thing -- an edge hue is never reused (or
 * near-reused) as a node/block fill, and (c) every edge hue stays legible
 * against the dark canvas and against every node fill it can cross.
 *
 * These are the rules the palette must satisfy; they are deliberately written
 * against the constants rather than against specific hex values so the palette
 * can be re-tuned without rewriting the test.
 */

// ---------------------------------------------------------------------------
// Colour maths (test-local; mirrors sRGB -> linear -> CIE Lab)
// ---------------------------------------------------------------------------

const HEX_RE = /^#[0-9a-f]{6}$/;

function hexToRgb(hex: string): [number, number, number] {
  assert.match(hex, HEX_RE, `${hex} must be lowercase #rrggbb`);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21). 3.0 is the minimum for non-text graphics. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function toLab(hex: string): [number, number, number] {
  const [lr, lg, lb] = hexToRgb(hex).map(srgbToLinear);
  let x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  let y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  let z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 perceptual distance. ~2.3 is "just noticeable"; >=20 is unmistakable. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** HSL saturation in 0..1, used as a coarse "how vivid is this" measure. */
function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}

/** Node fills darken the block colour by this factor (see nodeCreation.ts). */
const BLOCK_FILL_DARKEN = 0.25;

function darken(hex: string, factor: number): string {
  const channels = hexToRgb(hex)
    .map((c) => Math.floor(c * factor))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
  return `#${channels}`;
}

/** The Pixi canvas clear colour (PixiRenderer backgroundColor). */
const CANVAS_BACKGROUND = "#0f172a";

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

const ALL_BLOCK_KINDS: BlockKind[] = [
  "Function",
  "Class",
  "Struct",
  "Enum",
  "Trait",
  "Interface",
  "Impl",
  "Module",
  "Constant",
  "TypeAlias",
];

const edgeHexes = () => ALL_EDGE_KINDS.map((k) => EDGE_COLORS[k]);
const blockHexes = () => ALL_BLOCK_KINDS.map((k) => BLOCK_COLORS[k]);
const nodeHexes = () => [NODE_COLORS.Directory, NODE_COLORS.File];

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("every palette entry is a lowercase #rrggbb string", () => {
  for (const kind of ALL_EDGE_KINDS) assert.match(EDGE_COLORS[kind], HEX_RE, `EDGE_COLORS.${kind}`);
  for (const kind of ALL_BLOCK_KINDS) assert.match(BLOCK_COLORS[kind], HEX_RE, `BLOCK_COLORS.${kind}`);
  assert.match(NODE_COLORS.Directory, HEX_RE, "NODE_COLORS.Directory");
  assert.match(NODE_COLORS.File, HEX_RE, "NODE_COLORS.File");
});

// ---------------------------------------------------------------------------
// Hue budget: merged call hues and merged subtype hues
// ---------------------------------------------------------------------------

test("FunctionCall and MethodCall share a single 'calls' hue", () => {
  assert.equal(
    EDGE_COLORS.FunctionCall,
    EDGE_COLORS.MethodCall,
    "FunctionCall and MethodCall are both calls and must not cost two hues"
  );
});

test("Inheritance and TraitImpl share a single 'subtype' hue", () => {
  assert.equal(
    EDGE_COLORS.Inheritance,
    EDGE_COLORS.TraitImpl,
    "Inheritance and TraitImpl are both subtype relations and must not cost two hues"
  );
});

test("EDGE_COLORS spends at most 5 distinct hues", () => {
  const distinct = new Set(edgeHexes());
  assert.ok(
    distinct.size <= 5,
    `expected <=5 distinct edge hues, got ${distinct.size}: ${[...distinct].join(", ")}`
  );
});

test("the 5 edge hues are mutually unmistakable", () => {
  const distinct = [...new Set(edgeHexes())];
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const d = deltaE(distinct[i], distinct[j]);
      assert.ok(
        d >= 30,
        `edge hues ${distinct[i]} and ${distinct[j]} are only deltaE ${d.toFixed(1)} apart`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Deconfliction: a hue means exactly one thing
// ---------------------------------------------------------------------------

test("no hex value is shared across EDGE_COLORS, BLOCK_COLORS and NODE_COLORS", () => {
  const owners = new Map<string, string>();
  const register = (map: string, key: string, hex: string) => {
    const existing = owners.get(hex);
    assert.equal(
      existing,
      undefined,
      `${hex} is used by both ${existing} and ${map}.${key}; colour must identify one category`
    );
    owners.set(hex, `${map}.${key}`);
  };
  // Within EDGE_COLORS the merged hues are shared on purpose, so register the
  // distinct set rather than each kind.
  for (const hex of new Set(edgeHexes())) register("EDGE_COLORS", "(hue)", hex);
  for (const kind of ALL_BLOCK_KINDS) register("BLOCK_COLORS", kind, BLOCK_COLORS[kind]);
  register("NODE_COLORS", "Directory", NODE_COLORS.Directory);
  register("NODE_COLORS", "File", NODE_COLORS.File);
});

test("no edge hue is a near-duplicate of a block or node colour", () => {
  const targets = [
    ...ALL_BLOCK_KINDS.map((k) => [`BLOCK_COLORS.${k}`, BLOCK_COLORS[k]] as const),
    ["NODE_COLORS.Directory", NODE_COLORS.Directory] as const,
    ["NODE_COLORS.File", NODE_COLORS.File] as const,
  ];
  for (const hex of new Set(edgeHexes())) {
    for (const [label, target] of targets) {
      const d = deltaE(hex, target);
      assert.ok(
        d >= 20,
        `edge hue ${hex} is only deltaE ${d.toFixed(1)} from ${label} (${target})`
      );
    }
  }
});

test("block colours stay distinguishable from one another", () => {
  const hexes = blockHexes();
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const d = deltaE(hexes[i], hexes[j]);
      assert.ok(
        d >= 15,
        `block colours ${ALL_BLOCK_KINDS[i]} (${hexes[i]}) and ${ALL_BLOCK_KINDS[j]} (${hexes[j]}) are only deltaE ${d.toFixed(1)} apart`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Edges own the saturated end of the palette
// ---------------------------------------------------------------------------

test("every chromatic edge hue is more saturated than every block colour", () => {
  const blockMax = Math.max(...blockHexes().map(saturation));
  const chromaticEdges = [...new Set(edgeHexes())].filter((h) => saturation(h) > 0.35);
  assert.ok(chromaticEdges.length >= 4, "expected at least 4 chromatic edge hues");
  for (const hex of chromaticEdges) {
    assert.ok(
      saturation(hex) > blockMax,
      `edge hue ${hex} (sat ${saturation(hex).toFixed(2)}) must out-saturate every block colour (max ${blockMax.toFixed(2)})`
    );
  }
});

test("VariableUsage is the neutral, lowest-chroma edge hue", () => {
  const vu = EDGE_COLORS.VariableUsage;
  assert.ok(saturation(vu) < 0.35, `VariableUsage ${vu} should read as neutral grey`);
  for (const kind of ALL_EDGE_KINDS) {
    if (kind === "VariableUsage") continue;
    assert.ok(
      saturation(EDGE_COLORS[kind]) > saturation(vu),
      `${kind} should be more chromatic than VariableUsage`
    );
  }
});

// ---------------------------------------------------------------------------
// Legibility on the dark canvas
// ---------------------------------------------------------------------------

test("every edge hue is legible against the canvas and every node fill it crosses", () => {
  const surfaces: Array<[string, string]> = [
    ["canvas", CANVAS_BACKGROUND],
    ["Directory fill", NODE_COLORS.Directory],
    ["File fill", NODE_COLORS.File],
    ...ALL_BLOCK_KINDS.map(
      (k) => [`${k} fill`, darken(BLOCK_COLORS[k], BLOCK_FILL_DARKEN)] as [string, string]
    ),
  ];
  for (const hex of new Set(edgeHexes())) {
    for (const [label, surface] of surfaces) {
      const ratio = contrastRatio(hex, surface);
      assert.ok(
        ratio >= 3,
        `edge hue ${hex} on ${label} (${surface}) is only ${ratio.toFixed(2)}:1`
      );
    }
  }
});

test("Import stays the most distinct edge hue in module view", () => {
  // Module view shows only Import edges over File/Directory nodes, so Import
  // must clear the non-text contrast bar against both with headroom.
  for (const surface of nodeHexes()) {
    assert.ok(
      contrastRatio(EDGE_COLORS.Import, surface) >= 3.5,
      `Import ${EDGE_COLORS.Import} on ${surface} is too weak for the module view`
    );
  }
});
