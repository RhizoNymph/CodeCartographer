import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { CodeNode, BlockKind } from "../../api/types";
import { BLOCK_COLORS, NODE_COLORS } from "../../api/types";
import type { LayoutNodePosition } from "../layout/elkLayout";
import { drawNodeShape, DIRECTORY_TAB_HEIGHT } from "./shapes";
import { nodeBorderStyle, type NodeEmphasis } from "./nodeEmphasis";

export interface NodeDisplay {
  container: Container;
  bg: Graphics;
  label: Text;
  nodeData: CodeNode;
  layoutPos: LayoutNodePosition;
}

/**
 * Create the pixi display objects for a single graph node.
 * Returns the NodeDisplay record (container, bg, label, etc.).
 * Event handlers are NOT attached here -- the caller is responsible.
 */
export function createNodeDisplay(
  node: CodeNode,
  pos: LayoutNodePosition,
  emphasis: NodeEmphasis
): NodeDisplay {
  const container = new Container();
  container.x = pos.x;
  container.y = pos.y;
  container.eventMode = "static";
  container.cursor = "pointer";

  // Background
  const bg = new Graphics();
  const color = getNodeColor(node);
  const border = nodeBorderStyle(emphasis);

  drawNodeShape(bg, node, pos.width, pos.height, color, border.color, border.width);

  container.addChild(bg);

  // Label — shift down for directory tab; CodeBlock pills need centred text
  const fontSize = node.type === "CodeBlock" ? 11 : 13;
  const labelY =
    node.type === "Directory"
      ? DIRECTORY_TAB_HEIGHT + 4
      : node.type === "CodeBlock"
        ? (pos.height - fontSize) / 2
        : 6;
  const label = new Text({
    text: getNodeLabel(node),
    style: new TextStyle({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize,
      fill: node.type === "CodeBlock" ? "#cbd5e1" : "#f1f5f9",
      wordWrap: true,
      wordWrapWidth: Math.max(pos.width - 16, 40),
    }),
  });
  label.x = node.type === "CodeBlock" ? 12 : 8;
  label.y = labelY;
  container.addChild(label);

  return {
    container,
    bg,
    label,
    nodeData: node,
    layoutPos: pos,
  };
}

/** Node fills darken their palette colour by this factor to recede. */
export const BLOCK_FILL_DARKEN = 0.25;

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

export function getNodeColor(node: CodeNode): number {
  switch (node.type) {
    case "Directory":
      return hexToInt(NODE_COLORS.Directory);
    case "File":
      return hexToInt(NODE_COLORS.File);
    case "CodeBlock": {
      const hex = BLOCK_COLORS[node.kind] || "#334155";
      const base = hexToInt(hex);
      // Darken for background
      const r = Math.floor(((base >> 16) & 0xff) * BLOCK_FILL_DARKEN);
      const g = Math.floor(((base >> 8) & 0xff) * BLOCK_FILL_DARKEN);
      const b = Math.floor((base & 0xff) * BLOCK_FILL_DARKEN);
      return (r << 16) | (g << 8) | b;
    }
  }
}

export function getNodeLabel(node: CodeNode): string {
  switch (node.type) {
    case "Directory":
      return node.name;
    case "File":
      return node.name;
    case "CodeBlock":
      return `${blockKindPrefix(node.kind)} ${node.name}`;
  }
}

export function blockKindPrefix(kind: BlockKind): string {
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

export function getNodeLayer(node: CodeNode, containerLayer: Container, componentLayer: Container): Container {
  return node.type === "CodeBlock" ? componentLayer : containerLayer;
}
