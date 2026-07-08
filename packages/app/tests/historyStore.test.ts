import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Snapshot } from "../src/stores/historyStore.ts";
import { useHistoryStore } from "../src/stores/historyStore.ts";

function snapshot(id: string): Snapshot {
  return {
    visibleNodes: new Set([`visible-${id}`]),
    expandedNodes: new Set([`expanded-${id}`]),
    enabledEdgeKinds: new Set(["Import"]),
    hideUnconnectedNodes: id === "b",
  };
}

describe("useHistoryStore", () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it("undo returns the previous snapshot and saves the current snapshot for redo", () => {
    const previous = snapshot("a");
    const current = snapshot("b");

    useHistoryStore.getState().pushSnapshot(previous);

    const restored = useHistoryStore.getState().undo(current);
    assert.deepEqual(restored, previous);
    assert.equal(useHistoryStore.getState().canRedo, true);

    const redone = useHistoryStore.getState().redo(previous);
    assert.deepEqual(redone, current);
  });
});
