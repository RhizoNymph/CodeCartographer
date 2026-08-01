import { useEffect } from "react";
import { useGraphStore } from "../stores/graphStore";
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
 * selected one. Mirrors Esc-to-exit in FocusBreadcrumb.
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
        focusNodeId: store.focusNodeId,
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
