import { useEffect } from "react";
import { useGraphStore } from "../stores/graphStore";
import {
  resolveSelectionEscape,
  selectionFromStore,
  type SelectionEscapeEvent,
} from "../stores/selectionModel";

/** Project a DOM keydown onto the fields the pure resolver needs. */
function describeKeyEvent(e: KeyboardEvent): SelectionEscapeEvent {
  const target = e.target instanceof HTMLElement ? e.target : null;
  return {
    key: e.key,
    targetTagName: target ? target.tagName : null,
    targetIsEditable: target ? target.isContentEditable : false,
  };
}

/**
 * Esc precedence: the selection layer gets first refusal on Escape.
 *
 * If something is selected, Esc clears the selection (dropping the pinned edge
 * highlight) and stops there. If nothing is selected, the event is left
 * completely untouched so the focus layer's own Escape handling runs with
 * whatever semantics it has -- this hook neither knows nor cares what those are.
 *
 * The listener is registered in the CAPTURE phase so it sits strictly above the
 * bubble-phase window listeners the focus layer uses; `stopImmediatePropagation`
 * is called only when the selection actually consumes the key. Keydown always
 * targets the focused element (never `window` itself), so capture ordering here
 * is independent of which handler was registered first.
 */
export function useSelectionEscape() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useGraphStore.getState();
      const result = resolveSelectionEscape(
        describeKeyEvent(e),
        selectionFromStore(store.selectedNodeIds, store.selectedNodeId)
      );
      if (result.kind !== "clear-selection") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      store.clearSelection();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
