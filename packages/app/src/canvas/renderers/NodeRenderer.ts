/**
 * Re-export the canonical node creation functions and types.
 *
 * This file previously contained dead code. The real node display
 * implementation lives in nodeCreation.ts (factory functions) and
 * dragManager.ts (resizing / background redraw helpers).
 */
export {
  createNodeDisplay,
  getNodeColor,
  getNodeLabel,
  blockKindPrefix,
  getNodeLayer,
} from "./nodeCreation";

export type { NodeDisplay } from "./nodeCreation";

export { redrawNodeBg, syncDisplayBounds, updateNodeLabelWrap } from "./dragManager";
export { DragManager } from "./dragManager";
