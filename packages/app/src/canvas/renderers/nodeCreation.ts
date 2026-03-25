import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { CodeNode, BlockKind } from "../../api/types";
import { BLOCK_COLORS } from "../../api/types";
import type { LayoutNodePosition } from "../layout/elkLayout";

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
  nodeId: string,
  node: CodeNode,
  pos: LayoutNodePosition,
  selectedNodeId: string | null
): NodeDisplay {
  const container = new Container();
  container.x = pos.x;
  container.y = pos.y;
  container.eventMode = "static";
  container.cursor = "pointer";

  // Background
  const bg = new Graphics();
  const color = getNodeColor(node);
  const borderColor = selectedNodeId === nodeId ? 0x60a5fa : 0x334155;
  const borderWidth = selectedNodeId === nodeId ? 3 : 1;

  bg.roundRect(0, 0, pos.width, pos.height, 8);
  bg.fill({ color });
  bg.stroke({ color: borderColor, width: borderWidth });

  container.addChild(bg);

  // Label
  const fontSize = node.type === "CodeBlock" ? 11 : 13;
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
  label.x = 8;
  label.y = 6;
  container.addChild(label);

  return {
    container,
    bg,
    label,
    nodeData: node,
    layoutPos: pos,
  };
}

export function getNodeColor(node: CodeNode): number {
  switch (node.type) {
    case "Directory":
      return 0x1e293b;
    case "File":
      return 0x1e3a5f;
    case "CodeBlock": {
      const hex = BLOCK_COLORS[node.kind] || "#334155";
      const base = parseInt(hex.replace("#", ""), 16);
      // Darken for background
      const r = Math.floor(((base >> 16) & 0xff) * 0.25);
      const g = Math.floor(((base >> 8) & 0xff) * 0.25);
      const b = Math.floor((base & 0xff) * 0.25);
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
