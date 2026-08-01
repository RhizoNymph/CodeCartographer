import { useEffect } from "react";
import { useGraphStore } from "../stores/graphStore";

/**
 * Window-level Escape handling.
 *
 * Escape is a shared "back out one step" key, so its handling is a single
 * ordered precedence chain rather than a listener per component (the old
 * handler lived inside FocusBreadcrumb, which only mounts while focused).
 * Each step either consumes the key and returns, or falls through to the next.
 *
 * PRECEDENCE CHAIN -- keep in this order:
 *   1. (feat/pinned-selection) clear a pinned selection. Insert ABOVE the focus
 *      pop below, so Esc unpins before it starts leaving the neighborhood.
 *   2. Focus stack: pop exactly ONE frame. Focus exits only when the stack
 *      empties, so Esc retraces a drill-down the way the user walked in.
 */
export function useEscapeKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const store = useGraphStore.getState();

      // --- 1. pinned selection goes here (feat/pinned-selection) ---

      // --- 2. focus stack: pop one frame ---
      if (store.focusStack.length === 0) return;
      e.stopPropagation();
      e.preventDefault();
      // popFocus handles its own IPC failures; nothing to await here.
      void store.popFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
