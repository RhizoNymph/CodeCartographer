/**
 * Pure resolution of the "F" focus hotkey.
 *
 * The canvas Focus button used to live only in the hover tooltip, which
 * unmounts as soon as the pointer leaves the node -- so the button could never
 * be clicked. The hotkey needs no pointer travel at all: hover a node (or
 * select one) and press F.
 *
 * Kept free of DOM/store imports so the decision is testable in isolation;
 * `useFocusHotkey` adapts the real KeyboardEvent and dispatches the action.
 */

/** The parts of a keydown event the hotkey decision depends on. */
export interface FocusHotkeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Uppercased tag name of the event target, or null for non-elements. */
  targetTagName: string | null;
  /** Whether the event target is a contenteditable host. */
  targetIsEditable: boolean;
  /**
   * Whether this keydown came from the key being HELD (OS auto-repeat).
   * Optional: an omitted value means "not a repeat", which is what every
   * synthetic caller means and what the DOM reports for a first press.
   */
  repeat?: boolean;
  /** Whether the keydown was delivered mid-IME-composition. Optional as above. */
  isComposing?: boolean;
}

/** The graph-store state the hotkey decision depends on. */
export interface FocusHotkeyContext {
  hoveredNodeId: string | null;
  selectedNodeId: string | null;
  focusNodeId: string | null;
}

export type FocusHotkeyIgnoreReason =
  /** Some other key. */
  | "not-hotkey"
  /** Ctrl/Cmd/Alt held -- leave browser and OS shortcuts alone. */
  | "modifier"
  /** The key went into a text field (e.g. the sidebar search box). */
  | "typing"
  /** The keystroke belongs to an in-flight IME composition. */
  | "composing"
  /** OS auto-repeat from a held key -- one press means one focus. */
  | "repeat"
  /** Nothing is hovered or selected. */
  | "no-target"
  /** The target is already the active focus node. */
  | "already-focused";

export type FocusHotkeyResult =
  | { kind: "ignore"; reason: FocusHotkeyIgnoreReason }
  | { kind: "focus"; nodeId: string };

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Decide what a keydown should do. Hover wins over selection: `enterFocus`
 * sets `selectedNodeId` to the focused node, so a stale selection must never
 * shadow the node currently under the cursor.
 */
export function resolveFocusHotkey(
  event: FocusHotkeyEvent,
  context: FocusHotkeyContext
): FocusHotkeyResult {
  if (event.key.toLowerCase() !== "f") {
    return { kind: "ignore", reason: "not-hotkey" };
  }
  if (event.isComposing) {
    return { kind: "ignore", reason: "composing" };
  }
  // Auto-repeat is dropped BEFORE the target checks: each repeat would
  // otherwise dispatch its own get_neighborhood IPC round-trip, and the
  // already-focused guard cannot catch them until the first fetch resolves.
  if (event.repeat) {
    return { kind: "ignore", reason: "repeat" };
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return { kind: "ignore", reason: "modifier" };
  }
  if (
    event.targetIsEditable ||
    (event.targetTagName !== null && EDITABLE_TAGS.has(event.targetTagName))
  ) {
    return { kind: "ignore", reason: "typing" };
  }

  const nodeId = context.hoveredNodeId ?? context.selectedNodeId;
  if (nodeId === null) {
    return { kind: "ignore", reason: "no-target" };
  }
  if (nodeId === context.focusNodeId) {
    return { kind: "ignore", reason: "already-focused" };
  }
  return { kind: "focus", nodeId };
}
