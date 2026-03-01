import { create } from "zustand";

export type LODLevel = "minimap" | "overview" | "detail";

interface ViewportState {
  // Viewport bounds (world coordinates)
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;

  // LOD level based on zoom
  lodLevel: LODLevel;

  // Actions
  updateViewport: (x: number, y: number, w: number, h: number, scale: number) => void;
}

function getLODLevel(scale: number): LODLevel {
  if (scale < 0.15) return "minimap";
  if (scale < 0.5) return "overview";
  return "detail";
}

export const useViewportStore = create<ViewportState>((set) => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  scale: 1,
  lodLevel: "detail",

  updateViewport: (x, y, width, height, scale) =>
    set({
      x,
      y,
      width,
      height,
      scale,
      lodLevel: getLODLevel(scale),
    }),
}));
