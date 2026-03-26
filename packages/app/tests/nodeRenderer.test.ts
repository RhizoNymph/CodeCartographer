import assert from "node:assert/strict";
import test from "node:test";

import {
  EDGE_STYLES,
  DEFAULT_EDGE_STYLE,
  type NodePadding,
  type EdgeStyleConfig,
} from "../src/canvas/renderers/types.ts";

import type { BlockKind } from "../src/api/types.ts";
import { BLOCK_COLORS, EDGE_COLORS, NODE_COLORS } from "../src/api/types.ts";

/**
 * Tests for node rendering pure logic and the shared types module.
 *
 * nodeCreation.ts and dragManager.ts import pixi.js, so they cannot be tested
 * directly in Node.js. We test the pure-logic portions that don't require
 * pixi.js: the types module, the color/label lookup tables, and the
 * node-selection state machine (verified via invariant checks).
 */

// ---------------------------------------------------------------------------
// Pure reimplementations of node helper logic (mirrors nodeCreation.ts)
// ---------------------------------------------------------------------------

function blockKindPrefix(kind: BlockKind): string {
  switch (kind) {
    case "Function": return "fn";
    case "Class": return "class";
    case "Struct": return "struct";
    case "Enum": return "enum";
    case "Trait": return "trait";
    case "Interface": return "iface";
    case "Impl": return "impl";
    case "Module": return "mod";
    case "Constant": return "const";
    case "TypeAlias": return "type";
  }
}

function getNodeLabel(node: { type: string; name: string; kind?: BlockKind }): string {
  switch (node.type) {
    case "Directory":
      return node.name;
    case "File":
      return node.name;
    case "CodeBlock":
      return `${blockKindPrefix(node.kind!)} ${node.name}`;
    default:
      return node.name;
  }
}

function getNodeColorHex(node: { type: string; kind?: BlockKind }): number {
  switch (node.type) {
    case "Directory":
      return 0x1e293b;
    case "File":
      return 0x1e3a5f;
    case "CodeBlock": {
      const hex = BLOCK_COLORS[node.kind!] || "#334155";
      const base = parseInt(hex.replace("#", ""), 16);
      const r = Math.floor(((base >> 16) & 0xff) * 0.25);
      const g = Math.floor(((base >> 8) & 0xff) * 0.25);
      const b = Math.floor((base & 0xff) * 0.25);
      return (r << 16) | (g << 8) | b;
    }
    default:
      return 0x334155;
  }
}

// ---------------------------------------------------------------------------
// Tests: shared types
// ---------------------------------------------------------------------------

test("EDGE_STYLES covers all 7 edge kinds", () => {
  const kinds = Object.keys(EDGE_STYLES);
  assert.equal(kinds.length, 7);

  for (const kind of kinds) {
    const style = EDGE_STYLES[kind as keyof typeof EDGE_STYLES];
    assert.ok(style.width > 0);
    assert.ok(style.baseAlpha > 0 && style.baseAlpha <= 1);
  }
});

test("DEFAULT_EDGE_STYLE is a valid fallback", () => {
  assert.equal(typeof DEFAULT_EDGE_STYLE.width, "number");
  assert.equal(typeof DEFAULT_EDGE_STYLE.baseAlpha, "number");
  assert.ok(DEFAULT_EDGE_STYLE.width > 0);
});

test("VariableUsage has the lowest baseAlpha", () => {
  const vuAlpha = EDGE_STYLES.VariableUsage.baseAlpha;
  for (const [kind, style] of Object.entries(EDGE_STYLES)) {
    if (kind !== "VariableUsage") {
      assert.ok(
        style.baseAlpha >= vuAlpha,
        `${kind} (${style.baseAlpha}) should have >= alpha than VariableUsage (${vuAlpha})`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Tests: node labels
// ---------------------------------------------------------------------------

test("blockKindPrefix maps all BlockKind values correctly", () => {
  const expected: Record<BlockKind, string> = {
    Function: "fn",
    Class: "class",
    Struct: "struct",
    Enum: "enum",
    Trait: "trait",
    Interface: "iface",
    Impl: "impl",
    Module: "mod",
    Constant: "const",
    TypeAlias: "type",
  };

  for (const [kind, prefix] of Object.entries(expected)) {
    assert.equal(
      blockKindPrefix(kind as BlockKind),
      prefix,
      `Expected prefix for ${kind} to be "${prefix}"`
    );
  }
});

test("getNodeLabel returns directory name for Directory nodes", () => {
  assert.equal(getNodeLabel({ type: "Directory", name: "src" }), "src");
});

test("getNodeLabel returns file name for File nodes", () => {
  assert.equal(getNodeLabel({ type: "File", name: "main.ts" }), "main.ts");
});

test("getNodeLabel returns prefixed name for CodeBlock nodes", () => {
  assert.equal(
    getNodeLabel({ type: "CodeBlock", name: "handleClick", kind: "Function" }),
    "fn handleClick"
  );
  assert.equal(
    getNodeLabel({ type: "CodeBlock", name: "MyClass", kind: "Class" }),
    "class MyClass"
  );
});

// ---------------------------------------------------------------------------
// Tests: node colors
// ---------------------------------------------------------------------------

test("getNodeColorHex returns distinct colors for different node types", () => {
  const dirColor = getNodeColorHex({ type: "Directory" });
  const fileColor = getNodeColorHex({ type: "File" });
  const fnColor = getNodeColorHex({ type: "CodeBlock", kind: "Function" });
  const classColor = getNodeColorHex({ type: "CodeBlock", kind: "Class" });

  assert.equal(dirColor, 0x1e293b);
  assert.equal(fileColor, 0x1e3a5f);
  assert.notEqual(fnColor, dirColor);
  assert.notEqual(fnColor, fileColor);
  assert.notEqual(fnColor, classColor);
});

test("CodeBlock colors are darkened versions of BLOCK_COLORS", () => {
  for (const kind of Object.keys(BLOCK_COLORS) as BlockKind[]) {
    const color = getNodeColorHex({ type: "CodeBlock", kind });
    // The color should be darker (lower value) than the original
    const originalHex = BLOCK_COLORS[kind];
    const originalValue = parseInt(originalHex.replace("#", ""), 16);
    // After darkening by 0.25 factor, each channel is at most 25% of original
    assert.ok(
      color <= originalValue,
      `Darkened color for ${kind} (0x${color.toString(16)}) should be <= original (0x${originalValue.toString(16)})`
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: selected node state machine
// ---------------------------------------------------------------------------

test("setSelectedNode state machine: tracks previous and current", () => {
  // Simulate the state machine in PixiRenderer.setSelectedNode
  let selectedNodeId: string | null = null;
  const redrawCalls: Array<{ nodeId: string; selected: boolean }> = [];

  function setSelectedNode(nodeId: string | null) {
    const prev = selectedNodeId;
    selectedNodeId = nodeId;

    if (prev) {
      redrawCalls.push({ nodeId: prev, selected: false });
    }
    if (nodeId) {
      redrawCalls.push({ nodeId, selected: true });
    }
  }

  // Select node A
  setSelectedNode("A");
  assert.equal(redrawCalls.length, 1);
  assert.deepEqual(redrawCalls[0], { nodeId: "A", selected: true });

  // Select node B (should deselect A first)
  setSelectedNode("B");
  assert.equal(redrawCalls.length, 3);
  assert.deepEqual(redrawCalls[1], { nodeId: "A", selected: false });
  assert.deepEqual(redrawCalls[2], { nodeId: "B", selected: true });

  // Deselect all
  setSelectedNode(null);
  assert.equal(redrawCalls.length, 4);
  assert.deepEqual(redrawCalls[3], { nodeId: "B", selected: false });
});

// ---------------------------------------------------------------------------
// Tests: color constants
// ---------------------------------------------------------------------------

test("EDGE_COLORS has entries for all edge kinds", () => {
  const expectedKinds = [
    "Import",
    "FunctionCall",
    "MethodCall",
    "TypeReference",
    "Inheritance",
    "TraitImpl",
    "VariableUsage",
  ];

  for (const kind of expectedKinds) {
    const color = EDGE_COLORS[kind as keyof typeof EDGE_COLORS];
    assert.ok(color, `Missing EDGE_COLORS entry for ${kind}`);
    assert.ok(color.startsWith("#"), `${kind} color should be a hex string`);
    assert.equal(color.length, 7, `${kind} color should be #RRGGBB format`);
  }
});

test("BLOCK_COLORS has entries for all block kinds", () => {
  const expectedKinds: BlockKind[] = [
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

  for (const kind of expectedKinds) {
    const color = BLOCK_COLORS[kind];
    assert.ok(color, `Missing BLOCK_COLORS entry for ${kind}`);
    assert.ok(color.startsWith("#"), `${kind} color should be a hex string`);
  }
});

test("NODE_COLORS has Directory and File entries", () => {
  assert.ok(NODE_COLORS.Directory);
  assert.ok(NODE_COLORS.File);
});
