import { create } from "zustand";
import {
  unknownEdgeKindCounts,
  type EdgeKindCounts,
} from "../canvas/legend/edgeLegendModel";

/**
 * Per-kind edge counts for the current view, published by the layout pass.
 *
 * Kept in its own store rather than `graphStore` because it is layout OUTPUT,
 * not user state: `elkLayout` derives it from the `SubGraph` it fetches, and
 * `PixiRenderer` publishes it only after the stale-layout check, so a superseded
 * in-flight layout can never overwrite fresher counts.
 */
interface EdgeLegendState {
  counts: EdgeKindCounts;
  setCounts: (counts: EdgeKindCounts) => void;
}

export const useEdgeLegendStore = create<EdgeLegendState>((set) => ({
  counts: unknownEdgeKindCounts(),
  setCounts: (counts) => set({ counts }),
}));
