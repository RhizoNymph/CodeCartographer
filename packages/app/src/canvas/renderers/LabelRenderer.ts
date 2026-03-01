import { Text, TextStyle, Container } from "pixi.js";
import type { LODLevel } from "../../stores/viewportStore";

/**
 * Manages text labels with LOD-based visibility.
 */
export class LabelRenderer {
  private labels = new Map<string, Text>();

  createLabel(
    id: string,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: string,
    parent: Container
  ): Text {
    const existing = this.labels.get(id);
    if (existing) {
      existing.destroy();
    }

    const label = new Text({
      text,
      style: new TextStyle({
        fontFamily: "monospace",
        fontSize,
        fill: color,
      }),
    });
    label.x = x;
    label.y = y;

    parent.addChild(label);
    this.labels.set(id, label);
    return label;
  }

  updateLOD(lodLevel: LODLevel) {
    for (const [id, label] of this.labels) {
      // Hide detailed labels at overview/minimap zoom
      if (id.includes("::")) {
        // Code block labels
        label.visible = lodLevel === "detail";
      } else {
        // Directory/file labels
        label.visible = lodLevel !== "minimap";

        // Adjust font size based on LOD
        if (lodLevel === "overview") {
          label.style.fontSize = 10;
        } else {
          label.style.fontSize = 13;
        }
      }
    }
  }

  clear() {
    for (const [, label] of this.labels) {
      label.destroy();
    }
    this.labels.clear();
  }

  destroy() {
    this.clear();
  }
}
