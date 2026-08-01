import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveFocusHotkey,
  type FocusHotkeyContext,
  type FocusHotkeyEvent,
} from "../src/canvas/focusHotkey.ts";

const keyF: FocusHotkeyEvent = {
  key: "f",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  targetTagName: "BODY",
  targetIsEditable: false,
};

const nothing: FocusHotkeyContext = {
  hoveredNodeId: null,
  selectedNodeId: null,
  focusNodeId: null,
};

describe("focus hotkey resolution", () => {
  it("focuses the hovered node", () => {
    const result = resolveFocusHotkey(keyF, { ...nothing, hoveredNodeId: "fileA" });
    assert.deepEqual(result, { kind: "focus", nodeId: "fileA" });
  });

  it("accepts an uppercase F (shift held)", () => {
    const result = resolveFocusHotkey(
      { ...keyF, key: "F" },
      { ...nothing, hoveredNodeId: "fileA" }
    );
    assert.deepEqual(result, { kind: "focus", nodeId: "fileA" });
  });

  it("falls back to the selected node when nothing is hovered", () => {
    const result = resolveFocusHotkey(keyF, { ...nothing, selectedNodeId: "fileB" });
    assert.deepEqual(result, { kind: "focus", nodeId: "fileB" });
  });

  it("prefers the hovered node over the selected node", () => {
    const result = resolveFocusHotkey(keyF, {
      hoveredNodeId: "fileA",
      selectedNodeId: "fileB",
      focusNodeId: null,
    });
    assert.deepEqual(result, { kind: "focus", nodeId: "fileA" });
  });

  it("ignores keys other than f", () => {
    for (const key of ["g", "Escape", "Enter", "1", " "]) {
      const result = resolveFocusHotkey(
        { ...keyF, key },
        { ...nothing, hoveredNodeId: "fileA" }
      );
      assert.deepEqual(result, { kind: "ignore", reason: "not-hotkey" }, key);
    }
  });

  it("ignores f with a ctrl/meta/alt modifier so browser shortcuts still work", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      const result = resolveFocusHotkey(
        { ...keyF, [mod]: true },
        { ...nothing, hoveredNodeId: "fileA" }
      );
      assert.deepEqual(result, { kind: "ignore", reason: "modifier" }, mod);
    }
  });

  it("ignores f typed into a text field", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      const result = resolveFocusHotkey(
        { ...keyF, targetTagName: tag },
        { ...nothing, hoveredNodeId: "fileA" }
      );
      assert.deepEqual(result, { kind: "ignore", reason: "typing" }, tag);
    }
  });

  it("ignores f typed into a contenteditable element", () => {
    const result = resolveFocusHotkey(
      { ...keyF, targetIsEditable: true },
      { ...nothing, hoveredNodeId: "fileA" }
    );
    assert.deepEqual(result, { kind: "ignore", reason: "typing" });
  });

  it("ignores f when no node is hovered or selected", () => {
    const result = resolveFocusHotkey(keyF, nothing);
    assert.deepEqual(result, { kind: "ignore", reason: "no-target" });
  });

  it("is a no-op when the target is already the focused node", () => {
    const result = resolveFocusHotkey(keyF, {
      hoveredNodeId: "fileA",
      selectedNodeId: null,
      focusNodeId: "fileA",
    });
    assert.deepEqual(result, { kind: "ignore", reason: "already-focused" });
  });

  it("re-focuses onto a different node while focus mode is active", () => {
    const result = resolveFocusHotkey(keyF, {
      hoveredNodeId: "fileB",
      selectedNodeId: null,
      focusNodeId: "fileA",
    });
    assert.deepEqual(result, { kind: "focus", nodeId: "fileB" });
  });

  it("hovering a node while focused on another still wins over selection", () => {
    // enterFocus sets selectedNodeId to the focus node, so the selection
    // fallback must not shadow a live hover.
    const result = resolveFocusHotkey(keyF, {
      hoveredNodeId: "fileB",
      selectedNodeId: "fileA",
      focusNodeId: "fileA",
    });
    assert.deepEqual(result, { kind: "focus", nodeId: "fileB" });
  });
});
