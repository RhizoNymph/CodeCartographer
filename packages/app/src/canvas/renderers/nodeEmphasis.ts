/**
 * How prominently a node's border is drawn, and why.
 *
 * Node borders carry two independent signals, so they need a precedence rule
 * rather than a boolean:
 *
 *   - the node is selected (pinned) -- sticky, user-driven;
 *   - the node is an endpoint of the edge currently under the pointer --
 *     transient, and the answer to "where does this edge actually land?", which
 *     is the core edge-reading task in a dense view.
 *
 * Selection wins: hovering an edge that touches a pinned node must never make
 * that node look less selected than it is.
 *
 * Kept free of imports (no pixi, no store) so the decision is unit-testable and
 * loadable under `node --test`; the pixi-side `redrawNodeBg` consumes the style
 * table below.
 */

export type NodeEmphasis = "none" | "edge-endpoint" | "selected";

export interface NodeBorderStyle {
  /** Border colour as a pixi hex int. */
  readonly color: number;
  /** Border width in layout units. */
  readonly width: number;
}

/**
 * Border styling per emphasis level. Weight increases with emphasis so the
 * three levels stay tellable apart at a glance, and each level owns a distinct
 * colour: slate (plain), light blue (edge endpoint), blue (selected).
 */
export const NODE_EMPHASIS_STYLES: Record<NodeEmphasis, NodeBorderStyle> = {
  none: { color: 0x334155, width: 1 },
  "edge-endpoint": { color: 0x93c5fd, width: 2 },
  selected: { color: 0x60a5fa, width: 3 },
};

/** The border style for an emphasis level. */
export function nodeBorderStyle(emphasis: NodeEmphasis): NodeBorderStyle {
  return NODE_EMPHASIS_STYLES[emphasis];
}

/**
 * Resolve a node's emphasis from the two signals. Selection outranks being a
 * hovered edge's endpoint.
 */
export function resolveNodeEmphasis(
  isSelected: boolean,
  isEdgeEndpoint: boolean
): NodeEmphasis {
  if (isSelected) return "selected";
  if (isEdgeEndpoint) return "edge-endpoint";
  return "none";
}

/**
 * The node ids to emphasise for the edge under the pointer. Empty when no edge
 * is hovered; a self-loop collapses to its single endpoint.
 */
export function edgeEndpointIds(
  source: string | null,
  target: string | null
): ReadonlySet<string> {
  if (source === null || target === null) return new Set<string>();
  return new Set<string>([source, target]);
}

/**
 * Which node ids must be redrawn when the hovered edge's endpoint set changes:
 * the symmetric difference, so a node that stays an endpoint across a hover
 * change is left alone.
 */
export function emphasisRedrawIds(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>
): string[] {
  const changed: string[] = [];
  for (const id of previous) {
    if (!next.has(id)) changed.push(id);
  }
  for (const id of next) {
    if (!previous.has(id)) changed.push(id);
  }
  return changed;
}
