/**
 * Shared types used across renderer sub-modules.
 *
 * These interfaces describe the display/layout data structures that
 * PixiRenderer, EdgeDrawingManager, DragManager, and nodeCreation all operate on.
 */

import type { EdgeKind } from "../../api/types";
import type { EdgeAnchor, Point } from "../layout/edgeGeometry";

// Re-export NodeDisplay from nodeCreation (canonical definition lives there).
export type { NodeDisplay } from "./nodeCreation";

/**
 * Lightweight snapshot of a node's position used by the edge drawing system
 * to compute edge routing without holding a direct reference to the Pixi container.
 */
export interface NodeDisplayRef {
  containerX: number;
  containerY: number;
  layoutWidth: number;
  layoutHeight: number;
  layoutX: number;
  layoutY: number;
}

/**
 * Normalized edge data built from the layout result.
 * Stored once per layout cycle and reused across redraws.
 */
export interface EdgeDatum {
  source: string;
  target: string;
  color: string;
  kind: EdgeKind | null;
  originalPoints: Point[];
  sourceAnchor: EdgeAnchor;
  targetAnchor: EdgeAnchor;
}

/**
 * Per-edge-kind styling constants.
 */
export interface EdgeStyleConfig {
  width: number;
  baseAlpha: number;
}

/** Edge styling configuration by type. */
export const EDGE_STYLES: Record<EdgeKind, EdgeStyleConfig> = {
  Import: { width: 2.5, baseAlpha: 0.9 },
  Inheritance: { width: 2.5, baseAlpha: 0.9 },
  TraitImpl: { width: 2.5, baseAlpha: 0.85 },
  FunctionCall: { width: 2, baseAlpha: 0.8 },
  MethodCall: { width: 2, baseAlpha: 0.8 },
  TypeReference: { width: 2, baseAlpha: 0.75 },
  VariableUsage: { width: 1.5, baseAlpha: 0.5 },
};

export const DEFAULT_EDGE_STYLE: EdgeStyleConfig = { width: 2, baseAlpha: 0.85 };

/**
 * Padding for parent nodes that contain children.
 */
export interface NodePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
