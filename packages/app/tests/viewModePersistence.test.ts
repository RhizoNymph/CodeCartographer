import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Minimal in-memory localStorage stub so persistenceStore works under node:test.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
  new MemoryStorage();

// Import after the stub is installed.
type PersistMod = typeof import("../src/stores/persistenceStore.ts");
let mod: PersistMod;

before(async () => {
  mod = await import("../src/stores/persistenceStore.ts");
});

describe("viewMode persistence round-trip", () => {
  it("saves and restores viewMode alongside expanded/visible", () => {
    const path = "/repo/one";
    mod.saveFolderState(
      path,
      new Set(["root", "dirA"]),
      new Set(["root", "dirA", "fileA"]),
      "symbol"
    );
    const loaded = mod.loadFolderState(path);
    assert.ok(loaded);
    assert.equal(loaded!.viewMode, "symbol");
    assert.deepEqual(loaded!.expandedNodes.sort(), ["dirA", "root"]);
  });

  it("defaults viewMode to module when omitted (backward compat)", () => {
    const path = "/repo/two";
    // Save without a viewMode (older call signature -> defaults to module).
    mod.saveFolderState(path, new Set(["root"]), new Set(["root"]));
    const loaded = mod.loadFolderState(path);
    assert.ok(loaded);
    assert.equal(loaded!.viewMode, "module");
  });

  it("keeps distinct viewMode per folder", () => {
    mod.saveFolderState("/repo/a", new Set(["root"]), new Set(["root"]), "symbol");
    mod.saveFolderState("/repo/b", new Set(["root"]), new Set(["root"]), "module");
    assert.equal(mod.loadFolderState("/repo/a")!.viewMode, "symbol");
    assert.equal(mod.loadFolderState("/repo/b")!.viewMode, "module");
  });
});
