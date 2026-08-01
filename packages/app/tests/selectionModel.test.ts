import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SELECTION,
  invalidateSelection,
  reduceSelection,
  resolveHighlightSource,
  resolveSelectionClick,
  resolveSelectionEscape,
  selectionFromStore,
  selectionIds,
  selectionPrimary,
  selectionSize,
  selectionToStore,
  type SelectionState,
} from "../src/stores/selectionModel.ts";

/**
 * Tests for the pure selection model backing pinned selection + multi-select.
 *
 * The module is deliberately import-free so it can be loaded directly under
 * `node --test` (no Pixi / zustand / DOM anywhere in the dependency chain).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a selection by replaying clicks, so tests never fabricate state. */
function select(...nodeIds: string[]): SelectionState {
  let state = EMPTY_SELECTION;
  for (const [i, nodeId] of nodeIds.entries()) {
    state = reduceSelection(state, {
      kind: i === 0 ? "replace" : "toggle",
      nodeId,
    });
  }
  return state;
}

function ids(state: SelectionState): string[] {
  return [...selectionIds(state)];
}

// ---------------------------------------------------------------------------
// Selection reducer
// ---------------------------------------------------------------------------

test("empty selection has no ids and no primary", () => {
  assert.equal(EMPTY_SELECTION.status, "empty");
  assert.equal(selectionSize(EMPTY_SELECTION), 0);
  assert.equal(selectionPrimary(EMPTY_SELECTION), null);
  assert.deepEqual(ids(EMPTY_SELECTION), []);
});

test("replace on an empty selection selects exactly one node", () => {
  const state = reduceSelection(EMPTY_SELECTION, { kind: "replace", nodeId: "a" });
  assert.deepEqual(ids(state), ["a"]);
  assert.equal(selectionPrimary(state), "a");
});

test("replace discards the previous selection entirely", () => {
  const state = reduceSelection(select("a", "b", "c"), { kind: "replace", nodeId: "d" });
  assert.deepEqual(ids(state), ["d"]);
  assert.equal(selectionPrimary(state), "d");
});

test("replace on an already-single selection is idempotent", () => {
  const first = select("a");
  const second = reduceSelection(first, { kind: "replace", nodeId: "a" });
  assert.deepEqual(ids(second), ["a"]);
  assert.equal(selectionPrimary(second), "a");
});

test("toggle adds an unselected node and makes it primary", () => {
  const state = reduceSelection(select("a"), { kind: "toggle", nodeId: "b" });
  assert.deepEqual(ids(state), ["a", "b"]);
  assert.equal(selectionPrimary(state), "b");
});

test("toggle on an empty selection behaves like a plain click", () => {
  const state = reduceSelection(EMPTY_SELECTION, { kind: "toggle", nodeId: "a" });
  assert.deepEqual(ids(state), ["a"]);
  assert.equal(selectionPrimary(state), "a");
});

test("toggle removes an already-selected node", () => {
  const state = reduceSelection(select("a", "b", "c"), { kind: "toggle", nodeId: "b" });
  assert.deepEqual(ids(state), ["a", "c"]);
});

test("toggling the only selected node empties the selection", () => {
  const state = reduceSelection(select("a"), { kind: "toggle", nodeId: "a" });
  assert.equal(state.status, "empty");
  assert.equal(selectionPrimary(state), null);
});

test("removing a non-primary node leaves the primary alone", () => {
  const state = reduceSelection(select("a", "b", "c"), { kind: "toggle", nodeId: "a" });
  assert.deepEqual(ids(state), ["b", "c"]);
  assert.equal(selectionPrimary(state), "c");
});

test("removing the primary promotes the most recently added survivor", () => {
  const state = reduceSelection(select("a", "b", "c"), { kind: "toggle", nodeId: "c" });
  assert.deepEqual(ids(state), ["a", "b"]);
  assert.equal(selectionPrimary(state), "b");
});

test("clear empties any selection", () => {
  assert.equal(reduceSelection(select("a", "b"), { kind: "clear" }).status, "empty");
  assert.equal(reduceSelection(EMPTY_SELECTION, { kind: "clear" }).status, "empty");
});

test("reduceSelection never mutates the input state", () => {
  const before = select("a", "b");
  const snapshot = ids(before);
  reduceSelection(before, { kind: "toggle", nodeId: "a" });
  reduceSelection(before, { kind: "replace", nodeId: "z" });
  reduceSelection(before, { kind: "clear" });
  assert.deepEqual(ids(before), snapshot);
  assert.equal(selectionPrimary(before), "b");
});

test("the primary is always a member of the selection", () => {
  const states = [
    EMPTY_SELECTION,
    select("a"),
    select("a", "b", "c"),
    reduceSelection(select("a", "b", "c"), { kind: "toggle", nodeId: "c" }),
    reduceSelection(select("a", "b"), { kind: "replace", nodeId: "q" }),
  ];
  for (const state of states) {
    const primary = selectionPrimary(state);
    if (primary === null) {
      assert.equal(selectionSize(state), 0);
    } else {
      assert.ok(selectionIds(state).has(primary));
    }
  }
});

// ---------------------------------------------------------------------------
// Click -> action mapping
// ---------------------------------------------------------------------------

test("a plain click replaces the selection", () => {
  assert.deepEqual(resolveSelectionClick("a", { ctrlKey: false, metaKey: false }), {
    kind: "replace",
    nodeId: "a",
  });
});

test("ctrl-click and cmd-click toggle membership", () => {
  assert.deepEqual(resolveSelectionClick("a", { ctrlKey: true, metaKey: false }), {
    kind: "toggle",
    nodeId: "a",
  });
  assert.deepEqual(resolveSelectionClick("a", { ctrlKey: false, metaKey: true }), {
    kind: "toggle",
    nodeId: "a",
  });
});

// ---------------------------------------------------------------------------
// Store-shape round trip
// ---------------------------------------------------------------------------

test("selectionToStore exposes the flat store shape", () => {
  const store = selectionToStore(select("a", "b"));
  assert.deepEqual([...store.selectedNodeIds], ["a", "b"]);
  assert.equal(store.selectedNodeId, "b");

  const empty = selectionToStore(EMPTY_SELECTION);
  assert.deepEqual([...empty.selectedNodeIds], []);
  assert.equal(empty.selectedNodeId, null);
});

test("selectionFromStore round-trips a consistent store shape", () => {
  const original = select("a", "b", "c");
  const store = selectionToStore(original);
  const restored = selectionFromStore(store.selectedNodeIds, store.selectedNodeId);
  assert.deepEqual(ids(restored), ["a", "b", "c"]);
  assert.equal(selectionPrimary(restored), "c");
});

test("selectionFromStore repairs a primary that is not a member", () => {
  const repaired = selectionFromStore(new Set(["a", "b"]), "gone");
  assert.deepEqual(ids(repaired), ["a", "b"]);
  assert.equal(selectionPrimary(repaired), "b");
});

test("selectionFromStore ignores a primary with an empty set", () => {
  assert.equal(selectionFromStore(new Set<string>(), "a").status, "empty");
});

// ---------------------------------------------------------------------------
// Invalidation on graph change
// ---------------------------------------------------------------------------

const exists = (present: string[]) => (id: string) => present.includes(id);

test("invalidation drops ids that left the graph", () => {
  const state = invalidateSelection(select("a", "b", "c"), exists(["a", "c"]));
  assert.deepEqual(ids(state), ["a", "c"]);
});

test("invalidation empties the selection when nothing survives", () => {
  const state = invalidateSelection(select("a", "b"), exists([]));
  assert.equal(state.status, "empty");
  assert.equal(selectionPrimary(state), null);
});

test("invalidation re-derives the primary when the primary is gone", () => {
  const state = invalidateSelection(select("a", "b", "c"), exists(["a", "b"]));
  assert.deepEqual(ids(state), ["a", "b"]);
  assert.equal(selectionPrimary(state), "b");
});

test("invalidation keeps a surviving primary", () => {
  const state = invalidateSelection(select("a", "b", "c"), exists(["b", "c"]));
  assert.equal(selectionPrimary(state), "c");
});

test("invalidation returns the same state when every id survives", () => {
  const before = select("a", "b");
  assert.equal(invalidateSelection(before, exists(["a", "b", "z"])), before);
});

test("invalidating an empty selection is a no-op", () => {
  assert.equal(invalidateSelection(EMPTY_SELECTION, exists(["a"])), EMPTY_SELECTION);
});

// ---------------------------------------------------------------------------
// Highlight source precedence: hover > pinned selection > none
// ---------------------------------------------------------------------------

test("nothing hovered and nothing selected highlights nothing", () => {
  assert.deepEqual(resolveHighlightSource(null, EMPTY_SELECTION), { mode: "none" });
});

test("hover highlights the hovered node's connections", () => {
  assert.deepEqual(resolveHighlightSource("h", EMPTY_SELECTION), {
    mode: "connected",
    nodeId: "h",
  });
});

test("a single pinned node keeps the connected highlight after unhover", () => {
  assert.deepEqual(resolveHighlightSource(null, select("a")), {
    mode: "connected",
    nodeId: "a",
  });
});

test("hover wins over a single pinned node", () => {
  assert.deepEqual(resolveHighlightSource("h", select("a")), {
    mode: "connected",
    nodeId: "h",
  });
});

test("two or more pinned nodes highlight the induced subgraph", () => {
  const source = resolveHighlightSource(null, select("a", "b"));
  assert.equal(source.mode, "induced");
  assert.ok(source.mode === "induced");
  assert.deepEqual([...source.nodeIds], ["a", "b"]);
});

test("hover wins over a multi-node selection", () => {
  assert.deepEqual(resolveHighlightSource("h", select("a", "b", "c")), {
    mode: "connected",
    nodeId: "h",
  });
});

test("unhovering a multi-selection falls back to the induced subgraph", () => {
  const selection = select("a", "b");
  const hovering = resolveHighlightSource("h", selection);
  const unhovered = resolveHighlightSource(null, selection);
  assert.equal(hovering.mode, "connected");
  assert.equal(unhovered.mode, "induced");
});

test("shrinking a multi-selection back to one node returns to connected mode", () => {
  const selection = reduceSelection(select("a", "b"), { kind: "toggle", nodeId: "b" });
  assert.deepEqual(resolveHighlightSource(null, selection), {
    mode: "connected",
    nodeId: "a",
  });
});

// ---------------------------------------------------------------------------
// Esc precedence: selection clears first, then focus handling
// ---------------------------------------------------------------------------

const escape = { key: "Escape", targetTagName: null, targetIsEditable: false };

test("Esc clears a non-empty selection instead of falling through", () => {
  assert.deepEqual(resolveSelectionEscape(escape, select("a")), { kind: "clear-selection" });
  assert.deepEqual(resolveSelectionEscape(escape, select("a", "b")), {
    kind: "clear-selection",
  });
});

test("Esc with no selection falls through to focus handling", () => {
  assert.deepEqual(resolveSelectionEscape(escape, EMPTY_SELECTION), {
    kind: "fall-through",
    reason: "no-selection",
  });
});

test("keys other than Esc never touch the selection", () => {
  for (const key of ["f", "Enter", "Delete", "Backspace", " ", "esc"]) {
    assert.deepEqual(resolveSelectionEscape({ ...escape, key }, select("a")), {
      kind: "fall-through",
      reason: "not-escape",
    });
  }
});

test("Esc typed into a text field falls through", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.deepEqual(
      resolveSelectionEscape({ ...escape, targetTagName: tag }, select("a")),
      { kind: "fall-through", reason: "typing" }
    );
  }
  assert.deepEqual(
    resolveSelectionEscape({ ...escape, targetIsEditable: true }, select("a")),
    { kind: "fall-through", reason: "typing" }
  );
});

test("Esc on a non-editable element still clears the selection", () => {
  assert.deepEqual(
    resolveSelectionEscape({ ...escape, targetTagName: "DIV" }, select("a")),
    { kind: "clear-selection" }
  );
});
