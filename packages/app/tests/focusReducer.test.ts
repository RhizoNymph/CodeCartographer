import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reduceSetViewMode,
  reduceEnterFocus,
  reduceExitFocus,
  type FocusViewState,
} from "../src/stores/graphViewModel.ts";

const base: FocusViewState = {
  viewMode: "module",
  focusNodeId: null,
  focusDepth: 1,
};

describe("focus-state reducer behavior", () => {
  it("entering focus forces symbol view and records node + depth", () => {
    const next = reduceEnterFocus(base, "fileA", 2);
    assert.equal(next.viewMode, "symbol");
    assert.equal(next.focusNodeId, "fileA");
    assert.equal(next.focusDepth, 2);
  });

  it("switching to module view drops any active focus", () => {
    const focused: FocusViewState = {
      viewMode: "symbol",
      focusNodeId: "fileA",
      focusDepth: 1,
    };
    const next = reduceSetViewMode(focused, "module");
    assert.equal(next.viewMode, "module");
    assert.equal(next.focusNodeId, null);
  });

  it("switching to symbol view preserves focus", () => {
    const focused: FocusViewState = {
      viewMode: "symbol",
      focusNodeId: "fileA",
      focusDepth: 1,
    };
    const next = reduceSetViewMode(focused, "symbol");
    assert.equal(next.viewMode, "symbol");
    assert.equal(next.focusNodeId, "fileA");
  });

  it("exiting focus clears the focus node but keeps symbol view", () => {
    const focused: FocusViewState = {
      viewMode: "symbol",
      focusNodeId: "fileA",
      focusDepth: 2,
    };
    const next = reduceExitFocus(focused);
    assert.equal(next.focusNodeId, null);
    assert.equal(next.viewMode, "symbol");
    assert.equal(next.focusDepth, 2, "depth is retained for the next focus");
  });

  it("reducers are pure (do not mutate input)", () => {
    const input: FocusViewState = {
      viewMode: "symbol",
      focusNodeId: "x",
      focusDepth: 1,
    };
    reduceSetViewMode(input, "module");
    reduceExitFocus(input);
    assert.equal(input.viewMode, "symbol");
    assert.equal(input.focusNodeId, "x");
  });
});
