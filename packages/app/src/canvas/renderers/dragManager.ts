import type { CodeGraph, CodeNode } from "../../api/types";
import type { LayoutNodePosition, LayoutResult } from "../layout/elkLayout";
import { getNodeColor, type NodeDisplay } from "./nodeCreation";
import { drawNodeShape } from "./shapes";
import type { NodePadding } from "./types";

interface DragTarget {
  nodeId: string;
  offsetX: number;
  offsetY: number;
  /** Track descendants to move with parent */
  descendants: Array<{ nodeId: string; relX: number; relY: number }>;
}

/**
 * Manages drag state and ancestor resizing during node drags.
 */
export class DragManager {
  dragTarget: DragTarget | null = null;

  /**
   * Collect all descendant node IDs with their positions relative to the parent.
   */
  collectDescendants(
    parentId: string,
    parentX: number,
    parentY: number,
    graph: CodeGraph | null,
    nodeDisplays: Map<string, NodeDisplay>
  ): Array<{ nodeId: string; relX: number; relY: number }> {
    const result: Array<{ nodeId: string; relX: number; relY: number }> = [];
    if (!graph) return result;

    const collectChildren = (nodeId: string) => {
      const node = graph.nodes[nodeId];
      if (!node) return;

      for (const childId of node.children) {
        const childDisplay = nodeDisplays.get(childId);
        if (childDisplay) {
          result.push({
            nodeId: childId,
            relX: childDisplay.container.x - parentX,
            relY: childDisplay.container.y - parentY,
          });
          // Recursively collect grandchildren
          collectChildren(childId);
        }
      }
    };

    collectChildren(parentId);
    return result;
  }

  /**
   * Walk up the ancestor chain, resizing each ancestor to fit its children.
   */
  resizeAncestorChain(
    nodeId: string,
    parentByNodeId: Map<string, string>,
    graph: CodeGraph | null,
    nodeDisplays: Map<string, NodeDisplay>,
    currentVisibleNodes: Set<string>,
    selectedNodeIds: ReadonlySet<string>,
    lastLayout: LayoutResult | null
  ): void {
    let currentId = parentByNodeId.get(nodeId) ?? null;

    while (currentId) {
      this.resizeNodeToFitChildren(
        currentId,
        graph,
        nodeDisplays,
        currentVisibleNodes,
        selectedNodeIds,
        lastLayout
      );
      currentId = parentByNodeId.get(currentId) ?? null;
    }
  }

  /**
   * Resize a single node to fit its visible children, updating display and layout.
   */
  private resizeNodeToFitChildren(
    nodeId: string,
    graph: CodeGraph | null,
    nodeDisplays: Map<string, NodeDisplay>,
    currentVisibleNodes: Set<string>,
    selectedNodeIds: ReadonlySet<string>,
    lastLayout: LayoutResult | null
  ): void {
    const display = nodeDisplays.get(nodeId);
    const node = graph?.nodes[nodeId];
    if (!display || !node) {
      return;
    }

    const padding = getNodePadding(node);
    const minSize = getMinimumNodeSize(node);
    let nextX = display.container.x;
    let nextY = display.container.y;
    let nextWidth = minSize.width;
    let nextHeight = minSize.height;
    let maxChildRight = nextX + minSize.width - padding.right;
    let maxChildBottom = nextY + minSize.height - padding.bottom;

    for (const childId of node.children) {
      if (!currentVisibleNodes.has(childId)) continue;

      const childDisplay = nodeDisplays.get(childId);
      if (!childDisplay) continue;

      nextX = Math.min(nextX, childDisplay.container.x - padding.left);
      nextY = Math.min(nextY, childDisplay.container.y - padding.top);
      maxChildRight = Math.max(
        maxChildRight,
        childDisplay.container.x + childDisplay.layoutPos.width
      );
      maxChildBottom = Math.max(
        maxChildBottom,
        childDisplay.container.y + childDisplay.layoutPos.height
      );
    }

    nextWidth = Math.max(nextWidth, Math.ceil(maxChildRight - nextX + padding.right));
    nextHeight = Math.max(nextHeight, Math.ceil(maxChildBottom - nextY + padding.bottom));

    if (
      nextX === display.container.x &&
      nextY === display.container.y &&
      nextWidth === display.layoutPos.width &&
      nextHeight === display.layoutPos.height
    ) {
      return;
    }

    display.container.x = nextX;
    display.container.y = nextY;
    display.layoutPos.width = nextWidth;
    display.layoutPos.height = nextHeight;
    redrawNodeBg(display, selectedNodeIds.has(nodeId));
    updateNodeLabelWrap(display);
    syncDisplayBounds(nodeId, display, lastLayout);
  }
}

function getMinimumNodeSize(node: CodeNode): { width: number; height: number } {
  switch (node.type) {
    case "Directory":
      return { width: 220, height: 70 };
    case "File":
      return { width: 180, height: 44 };
    case "CodeBlock":
      return { width: 150, height: 28 };
  }
}

function getNodePadding(node: CodeNode): NodePadding {
  if (node.children.length === 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  return { top: 30, right: 10, bottom: 10, left: 10 };
}

/**
 * Redraw a node's background graphics using the shared shape drawing.
 */
export function redrawNodeBg(display: NodeDisplay, selected: boolean): void {
  const bg = display.bg;
  const pos = display.layoutPos;
  const color = getNodeColor(display.nodeData);

  bg.clear();
  drawNodeShape(
    bg,
    display.nodeData,
    pos.width,
    pos.height,
    color,
    selected ? 0x60a5fa : 0x334155,
    selected ? 3 : 1
  );
}

/**
 * Update a node label's word-wrap width to match its current layout width.
 */
export function updateNodeLabelWrap(display: NodeDisplay): void {
  display.label.style.wordWrapWidth = Math.max(display.layoutPos.width - 16, 40);
}

/**
 * Sync a node display's bounds back into the layout result.
 */
export function syncDisplayBounds(
  nodeId: string,
  display: NodeDisplay,
  lastLayout: LayoutResult | null
): void {
  if (lastLayout?.nodes[nodeId]) {
    lastLayout.nodes[nodeId] = {
      ...lastLayout.nodes[nodeId],
      x: display.container.x,
      y: display.container.y,
      width: display.layoutPos.width,
      height: display.layoutPos.height,
    };
  }
}

