/**
 * Pure selection model: what is selected, what that implies for edge
 * highlighting, and how Esc arbitrates between selection and focus.
 *
 * Selection and "pinning" are the same concept. Hovering a node dims the base
 * edge layer and lights up its connections; clicking pins that treatment so it
 * survives the pointer leaving. Selecting two or more nodes switches the
 * highlight to the INDUCED subgraph (only edges with BOTH endpoints inside the
 * selection).
 *
 * The module is deliberately dependency-free (no zustand, no Pixi, no DOM) so
 * the decisions are unit-testable in isolation and the store/canvas layers only
 * have to adapt their runtime shapes onto it.
 */

/**
 * The selection, with the primary/member invariant encoded in the type: an
 * empty selection cannot carry a primary, and a non-empty one always has a
 * primary that is a member of `nodeIds`. Every value of this type is produced
 * by the constructors below, so no other code can build an inconsistent one.
 */
export type SelectionState =
  | { readonly status: "empty" }
  | {
      readonly status: "selected";
      readonly nodeIds: ReadonlySet<string>;
      /** Last-selected node. Always a member of `nodeIds`. */
      readonly primaryNodeId: string;
    };

export const EMPTY_SELECTION: SelectionState = { status: "empty" };

const NO_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Build a selection from an insertion-ordered id list. The primary is the last
 * entry unless `preferredPrimary` is still present, which keeps a surviving
 * primary stable across removals that did not touch it.
 */
function buildSelection(
  orderedIds: readonly string[],
  preferredPrimary: string | null
): SelectionState {
  if (orderedIds.length === 0) return EMPTY_SELECTION;
  const nodeIds = new Set(orderedIds);
  const primaryNodeId =
    preferredPrimary !== null && nodeIds.has(preferredPrimary)
      ? preferredPrimary
      : orderedIds[orderedIds.length - 1];
  return { status: "selected", nodeIds, primaryNodeId };
}

/** The selected ids, in selection order. Empty set when nothing is selected. */
export function selectionIds(state: SelectionState): ReadonlySet<string> {
  return state.status === "empty" ? NO_IDS : state.nodeIds;
}

/** The primary (last-selected) node, or null when nothing is selected. */
export function selectionPrimary(state: SelectionState): string | null {
  return state.status === "empty" ? null : state.primaryNodeId;
}

export function selectionSize(state: SelectionState): number {
  return state.status === "empty" ? 0 : state.nodeIds.size;
}

export function isNodeSelected(state: SelectionState, nodeId: string): boolean {
  return state.status !== "empty" && state.nodeIds.has(nodeId);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type SelectionAction =
  /** Plain click: the selection becomes exactly this node. */
  | { readonly kind: "replace"; readonly nodeId: string }
  /** Ctrl/Cmd-click: add the node if absent, remove it if present. */
  | { readonly kind: "toggle"; readonly nodeId: string }
  /** Empty-canvas click, the chip's Clear button, or Esc. */
  | { readonly kind: "clear" };

/**
 * Apply a selection action. Never mutates `state`.
 *
 * Primary rules:
 *  - adding a node (replace or toggle-in) makes it the primary;
 *  - removing a non-primary node leaves the primary alone;
 *  - removing the primary promotes the most recently added survivor.
 */
export function reduceSelection(
  state: SelectionState,
  action: SelectionAction
): SelectionState {
  switch (action.kind) {
    case "clear":
      return EMPTY_SELECTION;

    case "replace":
      return buildSelection([action.nodeId], action.nodeId);

    case "toggle": {
      const current = [...selectionIds(state)];
      if (!current.includes(action.nodeId)) {
        return buildSelection([...current, action.nodeId], action.nodeId);
      }
      const remaining = current.filter((id) => id !== action.nodeId);
      const primary = selectionPrimary(state);
      return buildSelection(remaining, primary === action.nodeId ? null : primary);
    }
  }
}

/** The modifier keys a click carries, as read off a pointer event. */
export interface SelectionClickModifiers {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** Map a node click onto a selection action. Ctrl/Cmd-click toggles. */
export function resolveSelectionClick(
  nodeId: string,
  modifiers: SelectionClickModifiers
): SelectionAction {
  return modifiers.ctrlKey || modifiers.metaKey
    ? { kind: "toggle", nodeId }
    : { kind: "replace", nodeId };
}

// ---------------------------------------------------------------------------
// Store shape adapters
// ---------------------------------------------------------------------------

/** The flat fields the graph store publishes for consumers to subscribe to. */
export interface SelectionStoreShape {
  readonly selectedNodeIds: ReadonlySet<string>;
  /** Derived primary; null iff `selectedNodeIds` is empty. */
  readonly selectedNodeId: string | null;
}

export function selectionToStore(state: SelectionState): SelectionStoreShape {
  return {
    selectedNodeIds: selectionIds(state),
    selectedNodeId: selectionPrimary(state),
  };
}

/**
 * Read the store shape back as a `SelectionState`, repairing any inconsistency
 * (a primary that is not a member, or a primary alongside an empty set) rather
 * than trusting the caller.
 */
export function selectionFromStore(
  selectedNodeIds: ReadonlySet<string>,
  selectedNodeId: string | null
): SelectionState {
  return buildSelection([...selectedNodeIds], selectedNodeId);
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Drop selected ids that no longer exist in the graph (a fresh parse, or any
 * other graph swap). Returns the same state object when everything survives so
 * store subscribers are not woken for a no-op.
 */
export function invalidateSelection(
  state: SelectionState,
  nodeExists: (nodeId: string) => boolean
): SelectionState {
  if (state.status === "empty") return state;

  const surviving = [...state.nodeIds].filter(nodeExists);
  if (surviving.length === state.nodeIds.size) return state;

  return buildSelection(surviving, state.primaryNodeId);
}

// ---------------------------------------------------------------------------
// Highlight source
// ---------------------------------------------------------------------------

/**
 * Which node ids drive the edge highlight, and how to read them.
 *
 * - `connected`: every edge touching this node (or its subtree) lights up.
 * - `induced`: only edges whose BOTH endpoints are inside the set light up.
 * - `none`: no dimming at all -- the base layer renders at full opacity.
 */
export type HighlightSource =
  | { readonly mode: "none" }
  | { readonly mode: "connected"; readonly nodeId: string }
  | { readonly mode: "induced"; readonly nodeIds: ReadonlySet<string> };

/**
 * Precedence: hover > pinned selection > none.
 *
 * While the pointer is over a node that node's connections win, so hovering
 * still previews any node without disturbing the pin. On unhover the highlight
 * falls back to the pinned selection instead of snapping to full opacity.
 */
export function resolveHighlightSource(
  hoveredNodeId: string | null,
  selection: SelectionState
): HighlightSource {
  if (hoveredNodeId !== null) {
    return { mode: "connected", nodeId: hoveredNodeId };
  }
  if (selection.status === "empty") {
    return { mode: "none" };
  }
  if (selection.nodeIds.size === 1) {
    return { mode: "connected", nodeId: selection.primaryNodeId };
  }
  return { mode: "induced", nodeIds: selection.nodeIds };
}

/** Whether a highlight source dims the base edge layer. */
export function highlightDimsBaseLayer(source: HighlightSource): boolean {
  return source.mode !== "none";
}

// ---------------------------------------------------------------------------
// Esc precedence
// ---------------------------------------------------------------------------

/** The parts of a keydown the Esc decision depends on. */
export interface SelectionEscapeEvent {
  readonly key: string;
  /** Uppercased tag name of the event target, or null for non-elements. */
  readonly targetTagName: string | null;
  /** Whether the event target is a contenteditable host. */
  readonly targetIsEditable: boolean;
}

export type SelectionEscapeFallThroughReason =
  /** Some other key. */
  | "not-escape"
  /** The key went into a text field (e.g. the sidebar search box). */
  | "typing"
  /** Nothing is selected, so Esc belongs to whoever handles it next. */
  | "no-selection";

export type SelectionEscapeResult =
  | { readonly kind: "clear-selection" }
  | {
      readonly kind: "fall-through";
      readonly reason: SelectionEscapeFallThroughReason;
    };

const EDITABLE_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Esc contract: clear the selection FIRST if there is one; otherwise fall
 * through untouched so the focus layer can handle Esc with its own semantics.
 * This function never knows anything about focus -- it only decides whether Esc
 * has been consumed by the selection layer.
 */
export function resolveSelectionEscape(
  event: SelectionEscapeEvent,
  selection: SelectionState
): SelectionEscapeResult {
  if (event.key !== "Escape") {
    return { kind: "fall-through", reason: "not-escape" };
  }
  if (
    event.targetIsEditable ||
    (event.targetTagName !== null && EDITABLE_TAGS.has(event.targetTagName))
  ) {
    return { kind: "fall-through", reason: "typing" };
  }
  if (selection.status === "empty") {
    return { kind: "fall-through", reason: "no-selection" };
  }
  return { kind: "clear-selection" };
}
