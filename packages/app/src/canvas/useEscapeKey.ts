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
 *   1. Selection: handled ABOVE this hook by `useSelectionEscape`, which runs in
 *      the CAPTURE phase and consumes Esc only while focus is INACTIVE. Do not
 *      add an unpin step here: entering/popping a focus frame re-selects the
 *      frame's node, so clearing the selection first would make backing out of
 *      an N-deep stack take 2N+1 presses.
 *   2. Focus stack: pop exactly ONE frame. Focus exits only when the stack
 *      empties, so Esc retraces a drill-down the way the user walked in.
 */
export function useEscapeKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const store = useGraphStore.getState();

      // --- 1. selection: owned by useSelectionEscape (capture phase, and only
      //         while unfocused) -- see the precedence note above ---

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
