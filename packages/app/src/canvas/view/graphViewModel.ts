import type { CodeGraph, EdgeKind } from "../../api/types";
import { computeDisplayVisibleNodes } from "../../stores/visibilityFilter.ts";

export interface GraphViewInput {
  graph: CodeGraph | null;
  expandedNodes: Set<string>;
  visibleNodes: Set<string>;
  enabledEdgeKinds: Set<EdgeKind>;
  hideUnconnectedNodes: boolean;
}

export interface GraphViewModel {
  graph: CodeGraph | null;
  expandedNodes: Set<string>;
  layoutVisibleNodes: Set<string>;
  manuallyVisibleNodes: Set<string>;
  enabledEdgeKinds: Set<EdgeKind>;
}

export function createGraphViewModel(input: GraphViewInput): GraphViewModel {
  return {
    graph: input.graph,
    expandedNodes: new Set(input.expandedNodes),
    manuallyVisibleNodes: new Set(input.visibleNodes),
    layoutVisibleNodes: computeDisplayVisibleNodes(
      input.graph,
      input.visibleNodes,
      input.enabledEdgeKinds,
      input.hideUnconnectedNodes
    ),
    enabledEdgeKinds: new Set(input.enabledEdgeKinds),
  };
}
