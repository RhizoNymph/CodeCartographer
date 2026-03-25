import { create } from "zustand";
import type { EdgeKind } from "../api/types";

export type LODLevel = "minimap" | "overview" | "detail";

// LOD settings for edge visibility/opacity
export interface EdgeLODSettings {
  minimapOpacity: number;      // 0-1, opacity at minimap zoom
  overviewOpacity: number;     // 0-1, opacity at overview zoom
  showEdgesInMinimap: boolean; // Whether to show edges at all in minimap
  hideAtOverview: Set<EdgeKind>; // Edge kinds to hide at overview level
}

const DEFAULT_EDGE_LOD_SETTINGS: EdgeLODSettings = {
  minimapOpacity: 0.2,
  overviewOpacity: 0.5,
  showEdgesInMinimap: true,
  hideAtOverview: new Set<EdgeKind>(["VariableUsage"]),
};

interface ViewportState {
  // Viewport bounds (world coordinates)
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;

  // LOD level based on zoom
  lodLevel: LODLevel;

  // Edge LOD settings
  edgeLODSettings: EdgeLODSettings;

  // Actions
  updateViewport: (x: number, y: number, w: number, h: number, scale: number) => void;
  setEdgeLODSettings: (settings: Partial<EdgeLODSettings>) => void;
}

function getLODLevel(scale: number): LODLevel {
  if (scale < 0.05) return "minimap";  // Very zoomed out
  if (scale < 0.2) return "overview";   // Moderately zoomed out
  return "detail";
}

// Load settings from localStorage
function loadEdgeLODSettings(): EdgeLODSettings {
  try {
    const saved = localStorage.getItem("edgeLODSettings");
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        minimapOpacity: parsed.minimapOpacity ?? DEFAULT_EDGE_LOD_SETTINGS.minimapOpacity,
        overviewOpacity: parsed.overviewOpacity ?? DEFAULT_EDGE_LOD_SETTINGS.overviewOpacity,
        showEdgesInMinimap: parsed.showEdgesInMinimap ?? DEFAULT_EDGE_LOD_SETTINGS.showEdgesInMinimap,
        hideAtOverview: new Set<EdgeKind>(parsed.hideAtOverview ?? Array.from(DEFAULT_EDGE_LOD_SETTINGS.hideAtOverview)),
      };
    }
  } catch (e) {
    console.warn("Failed to load edge LOD settings:", e);
  }
  return { ...DEFAULT_EDGE_LOD_SETTINGS };
}

// Save settings to localStorage
function saveEdgeLODSettings(settings: EdgeLODSettings) {
  try {
    localStorage.setItem("edgeLODSettings", JSON.stringify({
      minimapOpacity: settings.minimapOpacity,
      overviewOpacity: settings.overviewOpacity,
      showEdgesInMinimap: settings.showEdgesInMinimap,
      hideAtOverview: Array.from(settings.hideAtOverview),
    }));
  } catch (e) {
    console.warn("Failed to save edge LOD settings:", e);
  }
}

export const useViewportStore = create<ViewportState>((set, get) => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  scale: 1,
  lodLevel: "detail",
  edgeLODSettings: loadEdgeLODSettings(),

  updateViewport: (x, y, width, height, scale) =>
    set({
      x,
      y,
      width,
      height,
      scale,
      lodLevel: getLODLevel(scale),
    }),

  setEdgeLODSettings: (newSettings) => {
    const current = get().edgeLODSettings;
    const updated = { ...current, ...newSettings };
    saveEdgeLODSettings(updated);
    set({ edgeLODSettings: updated });
  },
}));
