import { useEffect } from "react";
import { useGraphStore } from "../stores/graphStore";
import { focusTopNodeId } from "../stores/graphViewModel";
import { resolveFocusHotkey, type FocusHotkeyEvent } from "./focusHotkey";

/** Project a DOM keydown onto the fields the pure resolver needs. */
function describeKeyEvent(e: KeyboardEvent): FocusHotkeyEvent {
  const target = e.target instanceof HTMLElement ? e.target : null;
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    targetTagName: target ? target.tagName : null,
    targetIsEditable: target ? target.isContentEditable : false,
  };
}

/**
 * Window-level "F" hotkey: enter focus on the hovered node, falling back to the
 * selected one. Each press pushes a focus frame; `useEscapeKey` pops back out
 * one frame at a time.
 *
 * Reads the store imperatively via getState() so the listener is installed once
 * and never goes stale on hover changes (which fire on every pointerover).
 */
export function useFocusHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useGraphStore.getState();
      const result = resolveFocusHotkey(describeKeyEvent(e), {
        hoveredNodeId: store.hoveredNodeId,
        selectedNodeId: store.selectedNodeId,
        // Only the frame on screen counts as "already focused": F on a node
        // deeper in the stack is a legitimate re-drill.
        focusNodeId: focusTopNodeId(store.focusStack),
      });
      if (result.kind !== "focus") return;
      e.preventDefault();
      // enterFocus handles its own IPC failures; nothing to await here.
      void store.enterFocus(result.nodeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
