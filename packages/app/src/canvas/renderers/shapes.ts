import { Graphics } from "pixi.js";
import type { CodeNode } from "../../api/types";

/**
 * Draw the appropriate shape for a node type onto a Graphics object.
 *
 * - Directory: folder tab (trapezoid) above a rounded rectangle body
 * - File: rounded rectangle with a dog-ear fold at top-right
 * - CodeBlock: pill / capsule (fully rounded ends)
 */
export function drawNodeShape(
  gfx: Graphics,
  node: CodeNode,
  width: number,
  height: number,
  fillColor: number,
  strokeColor: number,
  strokeWidth: number
): void {
  switch (node.type) {
    case "Directory":
      drawDirectoryShape(gfx, width, height, fillColor, strokeColor, strokeWidth);
      break;
    case "File":
      drawFileShape(gfx, width, height, fillColor, strokeColor, strokeWidth);
      break;
    case "CodeBlock":
      drawCodeBlockShape(gfx, width, height, fillColor, strokeColor, strokeWidth);
      break;
  }
}

/** Height of the folder tab above the main body. */
export const DIRECTORY_TAB_HEIGHT = 10;

function drawDirectoryShape(
  gfx: Graphics,
  width: number,
  height: number,
  fillColor: number,
  strokeColor: number,
  strokeWidth: number
): void {
  const tabWidth = Math.min(60, width * 0.35);
  const tabHeight = DIRECTORY_TAB_HEIGHT;

  // Draw tab
  gfx.moveTo(0, tabHeight);
  gfx.lineTo(4, 0);
  gfx.lineTo(tabWidth - 4, 0);
  gfx.lineTo(tabWidth, tabHeight);
  gfx.closePath();
  gfx.fill({ color: fillColor });

  // Draw main body below tab
  gfx.roundRect(0, tabHeight, width, height - tabHeight, 6);
  gfx.fill({ color: fillColor });
  gfx.stroke({ color: strokeColor, width: strokeWidth });
}

function drawFileShape(
  gfx: Graphics,
  width: number,
  height: number,
  fillColor: number,
  strokeColor: number,
  strokeWidth: number
): void {
  const foldSize = 10;

  // Main outline with dog-ear at top-right
  gfx.moveTo(6, 0);
  gfx.lineTo(width - foldSize, 0);
  gfx.lineTo(width, foldSize);
  gfx.lineTo(width, height - 6);
  gfx.arcTo(width, height, width - 6, height, 6);
  gfx.lineTo(6, height);
  gfx.arcTo(0, height, 0, height - 6, 6);
  gfx.lineTo(0, 6);
  gfx.arcTo(0, 0, 6, 0, 6);
  gfx.closePath();
  gfx.fill({ color: fillColor });
  gfx.stroke({ color: strokeColor, width: strokeWidth });

  // Draw the fold triangle line
  gfx.moveTo(width - foldSize, 0);
  gfx.lineTo(width - foldSize, foldSize);
  gfx.lineTo(width, foldSize);
  gfx.stroke({ color: strokeColor, width: 0.5 });
}

function drawCodeBlockShape(
  gfx: Graphics,
  width: number,
  height: number,
  fillColor: number,
  strokeColor: number,
  strokeWidth: number
): void {
  // Pill / capsule shape: radius = half the height for fully rounded ends
  const radius = height / 2;
  gfx.roundRect(0, 0, width, height, radius);
  gfx.fill({ color: fillColor });
  gfx.stroke({ color: strokeColor, width: strokeWidth });
}
