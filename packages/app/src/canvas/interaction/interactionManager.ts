/**
 * Re-export the canonical drag/interaction manager.
 *
 * This file previously contained dead code. The real drag handling
 * implementation lives in renderers/dragManager.ts. Interaction event
 * handlers (pointerdown, globalpointermove, pointerup, pointertap,
 * pointerover/out) are wired up by PixiRenderer.addNodeDisplay().
 */
export { DragManager } from "../renderers/dragManager";
