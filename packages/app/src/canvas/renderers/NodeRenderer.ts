import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { CodeNode, BlockKind } from "../../api/types";
import { BLOCK_COLORS } from "../../api/types";

export interface NodeRenderOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  hovered: boolean;
}

/**
 * Creates and manages Pixi display objects for individual nodes.
 */
export class NodeRenderer {
  static createNode(
    node: CodeNode,
    options: NodeRenderOptions
  ): Container {
    const container = new Container();
    container.x = options.x;
    container.y = options.y;
    container.eventMode = "static";
    container.cursor = "pointer";

    // Background
    const bg = new Graphics();
    const bgColor = NodeRenderer.getNodeColor(node);
    const borderColor = options.selected ? 0x60a5fa : 0x334155;
    const borderWidth = options.selected ? 3 : 1;

    bg.roundRect(0, 0, options.width, options.height, 8);
    bg.fill({ color: bgColor });
    bg.stroke({ color: borderColor, width: borderWidth });

    container.addChild(bg);

    // Label
    const fontSize = node.type === "CodeBlock" ? 11 : 13;
    const text = NodeRenderer.getNodeLabel(node);

    const label = new Text({
      text,
      style: new TextStyle({
        fontFamily: "monospace",
        fontSize,
        fill: node.type === "CodeBlock" ? "#cbd5e1" : "#f1f5f9",
        wordWrap: true,
        wordWrapWidth: options.width - 16,
      }),
    });
    label.x = 8;
    label.y = 6;
    container.addChild(label);

    return container;
  }

  static getNodeColor(node: CodeNode): number {
    switch (node.type) {
      case "Directory":
        return 0x1e293b;
      case "File":
        return 0x1e3a5f;
      case "CodeBlock": {
        const hex = BLOCK_COLORS[node.kind] || "#334155";
        // Darken the block color for background
        const base = parseInt(hex.replace("#", ""), 16);
        const r = Math.floor(((base >> 16) & 0xff) * 0.3);
        const g = Math.floor(((base >> 8) & 0xff) * 0.3);
        const b = Math.floor((base & 0xff) * 0.3);
        return (r << 16) | (g << 8) | b;
      }
    }
  }

  static getNodeLabel(node: CodeNode): string {
    switch (node.type) {
      case "Directory":
        return node.name;
      case "File":
        return node.name;
      case "CodeBlock":
        return `${NodeRenderer.blockKindPrefix(node.kind)} ${node.name}`;
    }
  }

  static blockKindPrefix(kind: BlockKind): string {
    switch (kind) {
      case "Function": return "fn";
      case "Class": return "class";
      case "Struct": return "struct";
      case "Enum": return "enum";
      case "Trait": return "trait";
      case "Interface": return "interface";
      case "Impl": return "impl";
      case "Module": return "mod";
      case "Constant": return "const";
      case "TypeAlias": return "type";
    }
  }
}
