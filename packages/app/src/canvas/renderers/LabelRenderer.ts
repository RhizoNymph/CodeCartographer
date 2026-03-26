/**
 * Re-export the canonical label-related helpers.
 *
 * This file previously contained dead code. Labels are now managed inline
 * by nodeCreation.ts (createNodeDisplay sets up the Text) and
 * dragManager.ts (updateNodeLabelWrap adjusts word-wrap width).
 *
 * LOD-based label visibility is handled directly in PixiRenderer.updateLODVisibility().
 */
export { updateNodeLabelWrap } from "./dragManager";
