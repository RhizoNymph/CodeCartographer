import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reduceSetViewMode,
  reduceEnterFocus,
  reduceExitFocus,
  reducePopFocus,
  reducePopToFrame,
  reduceSetFocusDepth,
  reduceSetFocusDirection,
  nodeFrame,
  focusTopFrame,
  focusTopNodeId,
  focusIsActive,
  focusFrameKey,
  focusFrameLabel,
  truncateLabel,
  type FocusFrame,
  type FocusViewState,
} from "../src/stores/graphViewModel.ts";

const empty: FocusViewState = {
  viewMode: "module",
  focusStack: [],
};

/** A focused state whose stack is `frames`, in symbol view. */
function focused(...frames: FocusFrame[]): FocusViewState {
  return { viewMode: "symbol", focusStack: frames };
}

const A = nodeFrame("fnA", 1, "both");
const B = nodeFrame("fnB", 1, "both");
const C = nodeFrame("fnC", 2, "upstream");
const EDGE: FocusFrame = { type: "edge", source: "fnA", target: "fnB" };

describe("focus stack: entering focus", () => {
  it("entering focus from unfocused pushes the first frame and forces symbol view", () => {
    const next = reduceEnterFocus(empty, nodeFrame("fnA", 2, "downstream"));
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.focusStack, [
      { type: "node", nodeId: "fnA", depth: 2, direction: "downstream" },
    ]);
  });

  it("focusing a different node from within focus pushes a deeper frame", () => {
    const next = reduceEnterFocus(focused(A), B);
    assert.equal(next.focusStack.length, 2);
    assert.deepEqual(next.focusStack, [A, B]);
  });

  it("focusing the node of the CURRENT top frame replaces instead of pushing", () => {
    // Same node, different depth/direction -> the top frame is rewritten.
    const again = nodeFrame("fnB", 2, "upstream");
    const next = reduceEnterFocus(focused(A, B), again);
    assert.equal(next.focusStack.length, 2, "no duplicate frame is pushed");
    assert.deepEqual(next.focusStack, [A, again]);
  });

  it("focusing a node that is deeper in the stack (not the top) still pushes", () => {
    // Re-entering an ancestor is a drill-in, not a pop: only the TOP frame
    // dedupes. Popping back is the breadcrumb's job.
    const next = reduceEnterFocus(focused(A, B), A);
    assert.deepEqual(next.focusStack, [A, B, A]);
  });

  it("pushing an edge frame is handled generically by the stack mechanics", () => {
    const next = reduceEnterFocus(focused(A), EDGE);
    assert.deepEqual(next.focusStack, [A, EDGE]);
    // Re-entering the same edge replaces rather than duplicating.
    const same = reduceEnterFocus(next, { type: "edge", source: "fnA", target: "fnB" });
    assert.equal(same.focusStack.length, 2);
    // A different edge pushes.
    const other = reduceEnterFocus(next, { type: "edge", source: "fnB", target: "fnC" });
    assert.equal(other.focusStack.length, 3);
  });
});

describe("focus stack: leaving frames", () => {
  it("Esc pops exactly one frame, staying in focus while frames remain", () => {
    const next = reducePopFocus(focused(A, B, C));
    assert.deepEqual(next.focusStack, [A, B]);
    assert.equal(focusIsActive(next.focusStack), true);
  });

  it("successive Esc pops unwind the stack top-down and only then exit focus", () => {
    let s = focused(A, B, C);
    s = reducePopFocus(s);
    assert.deepEqual(s.focusStack, [A, B]);
    s = reducePopFocus(s);
    assert.deepEqual(s.focusStack, [A]);
    assert.equal(focusIsActive(s.focusStack), true, "still focused on the root frame");
    s = reducePopFocus(s);
    assert.deepEqual(s.focusStack, []);
    assert.equal(focusIsActive(s.focusStack), false, "focus exits only when empty");
    assert.equal(s.viewMode, "symbol", "leaving focus keeps the symbol view");
  });

  it("popping an already-empty stack is a no-op", () => {
    const next = reducePopFocus(empty);
    assert.deepEqual(next.focusStack, []);
  });

  it("X clears the whole stack in one step", () => {
    const next = reduceExitFocus(focused(A, B, C));
    assert.deepEqual(next.focusStack, []);
    assert.equal(next.viewMode, "symbol");
  });

  it("breadcrumb click pops back to the clicked frame, dropping everything above", () => {
    const next = reducePopToFrame(focused(A, B, C), 0);
    assert.deepEqual(next.focusStack, [A]);

    const mid = reducePopToFrame(focused(A, B, C), 1);
    assert.deepEqual(mid.focusStack, [A, B]);
  });

  it("clicking the current (last) breadcrumb frame changes nothing", () => {
    const next = reducePopToFrame(focused(A, B, C), 2);
    assert.deepEqual(next.focusStack, [A, B, C]);
  });

  it("clicking the root chip (index -1) clears the stack", () => {
    const next = reducePopToFrame(focused(A, B, C), -1);
    assert.deepEqual(next.focusStack, []);
  });

  it("popping to an out-of-range index leaves the stack untouched", () => {
    const next = reducePopToFrame(focused(A, B), 7);
    assert.deepEqual(next.focusStack, [A, B]);
  });
});

describe("focus stack: depth and direction are per-frame", () => {
  it("changing depth rewrites only the top frame", () => {
    const next = reduceSetFocusDepth(focused(A, B), 2);
    assert.deepEqual(next.focusStack, [A, { ...B, depth: 2 }]);
    assert.deepEqual(next.focusStack[0], A, "the parent frame keeps its own depth");
  });

  it("changing direction rewrites only the top frame", () => {
    const next = reduceSetFocusDirection(focused(A, B), "upstream");
    assert.deepEqual(next.focusStack, [A, { ...B, direction: "upstream" }]);
    assert.deepEqual(next.focusStack[0], A, "the parent frame keeps its own direction");
  });

  it("depth/direction changes are no-ops without a node frame on top", () => {
    assert.deepEqual(reduceSetFocusDepth(empty, 2).focusStack, []);
    assert.deepEqual(reduceSetFocusDirection(empty, "upstream").focusStack, []);
    const onEdge = focused(A, EDGE);
    assert.deepEqual(reduceSetFocusDepth(onEdge, 2).focusStack, [A, EDGE]);
    assert.deepEqual(
      reduceSetFocusDirection(onEdge, "downstream").focusStack,
      [A, EDGE]
    );
  });

  it("a pushed frame carries its own depth/direction, not the parent's", () => {
    const parent = nodeFrame("fnA", 2, "upstream");
    const next = reduceEnterFocus(focused(parent), nodeFrame("fnB", 1, "both"));
    assert.deepEqual(next.focusStack, [parent, nodeFrame("fnB", 1, "both")]);
  });
});

describe("focus stack: view mode interaction", () => {
  it("switching to module view drops the ENTIRE stack", () => {
    const next = reduceSetViewMode(focused(A, B, C), "module");
    assert.equal(next.viewMode, "module");
    assert.deepEqual(next.focusStack, []);
  });

  it("switching to symbol view preserves the stack", () => {
    const next = reduceSetViewMode(focused(A, B), "symbol");
    assert.equal(next.viewMode, "symbol");
    assert.deepEqual(next.focusStack, [A, B]);
  });
});

describe("focus stack: purity", () => {
  it("reducers never mutate the input state or its stack", () => {
    const input = focused(A, B);
    const stack = input.focusStack;
    reduceEnterFocus(input, C);
    reducePopFocus(input);
    reducePopToFrame(input, 0);
    reduceExitFocus(input);
    reduceSetFocusDepth(input, 2);
    reduceSetFocusDirection(input, "upstream");
    reduceSetViewMode(input, "module");
    assert.equal(input.focusStack, stack, "stack reference is untouched");
    assert.deepEqual(input.focusStack, [A, B]);
    assert.equal(input.viewMode, "symbol");
  });

  it("reducers return a new stack array rather than the input one", () => {
    const input = focused(A);
    assert.notEqual(reduceEnterFocus(input, B).focusStack, input.focusStack);
    assert.notEqual(reducePopFocus(input).focusStack, input.focusStack);
  });
});

describe("focus stack: derived accessors", () => {
  it("top frame / top node id / active", () => {
    assert.equal(focusTopFrame([]), null);
    assert.deepEqual(focusTopFrame([A, B]), B);
    assert.equal(focusTopNodeId([A, B]), "fnB");
    assert.equal(focusTopNodeId([]), null);
    assert.equal(
      focusTopNodeId([A, EDGE]),
      null,
      "an edge frame has no single focus node"
    );
    assert.equal(focusIsActive([]), false);
    assert.equal(focusIsActive([A]), true);
  });

  it("frame keys identify a frame's target, ignoring depth/direction", () => {
    assert.equal(focusFrameKey(nodeFrame("fnA", 1, "both")), focusFrameKey(nodeFrame("fnA", 2, "upstream")));
    assert.notEqual(focusFrameKey(A), focusFrameKey(B));
    assert.notEqual(focusFrameKey(A), focusFrameKey(EDGE));
  });
});

describe("focus stack: breadcrumb labels", () => {
  const names: Record<string, string> = {
    fnA: "load_config",
    fnB: "parse",
    fnC: "a_very_long_symbol_name_that_will_not_fit",
  };
  const nameOf = (id: string) => names[id] ?? id;

  it("a node frame is labelled with the node name", () => {
    assert.equal(focusFrameLabel(A, nameOf), "load_config");
  });

  it("an unknown node falls back to its id", () => {
    assert.equal(focusFrameLabel(nodeFrame("ghost", 1, "both"), nameOf), "ghost");
  });

  it("an edge frame is labelled source -> target", () => {
    assert.equal(focusFrameLabel(EDGE, nameOf), "load_config → parse");
  });

  it("long labels are truncated with an ellipsis", () => {
    assert.equal(truncateLabel("short", 18), "short");
    assert.equal(truncateLabel("a_very_long_symbol_name", 10), "a_very_lo…");
    assert.equal(truncateLabel("exactlyten", 10), "exactlyten");
  });
});
