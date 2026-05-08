import { create } from "zustand";

export type VisualizationMode = "default" | "overview" | "architecture" | "dependency" | "hotspot";
export type HotspotMetric = "fanIn" | "fanOut" | "symbolCount";

export interface DependencyFlowState {
  nodeId: string;
  direction: "upstream" | "downstream" | "both";
  chainNodes: Set<string>;
}

interface VisualizationState {
  mode: VisualizationMode;
  hotspotMetric: HotspotMetric;
  dependencyFlow: DependencyFlowState | null;

  setMode: (mode: VisualizationMode) => void;
  setHotspotMetric: (metric: HotspotMetric) => void;
  setDependencyFlow: (flow: DependencyFlowState | null) => void;
}

export const useVisualizationStore = create<VisualizationState>((set) => ({
  mode: "default",
  hotspotMetric: "fanIn",
  dependencyFlow: null,

  setMode: (mode) =>
    set((state) => ({
      mode,
      // Clear dependency flow when switching away from dependency mode
      // Keep current value when switching to dependency mode
      dependencyFlow: mode === "dependency" ? state.dependencyFlow : null,
    })),

  setHotspotMetric: (metric) => set({ hotspotMetric: metric }),

  setDependencyFlow: (flow) => set({ dependencyFlow: flow }),
}));
