/**
 * Re-export the canonical EdgeDrawingManager and related types.
 *
 * This file previously contained dead code. The real edge rendering
 * implementation lives in edgeDrawing.ts and uses a two-layer
 * architecture (base + highlight) for efficient hover updates.
 */
export {
  EdgeDrawingManager,
  getLODEdgeOpacity,
  shouldHideEdgeKindAtLOD,
  getLODEdgeWidthMultiplier,
} from "./edgeDrawing";

export type { EdgeDatum, NodeDisplayRef } from "./types";
