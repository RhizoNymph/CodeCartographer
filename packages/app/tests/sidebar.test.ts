import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMatchingNodeIds } from "../src/sidebar/searchUtils.ts";

describe("computeMatchingNodeIds", () => {
    // Build a mock graph with a tree structure
    const mockGraph = {
        nodes: {
            "root": {
                type: "Directory" as const,
                name: "src",
                id: "root",
                path: "src",
                children: ["file1"],
            },
            "file1": {
                type: "File" as const,
                name: "utils.ts",
                id: "file1",
                path: "src/utils.ts",
                language: "TypeScript" as const,
                children: ["fn1"],
            },
            "fn1": {
                type: "CodeBlock" as const,
                name: "parseInput",
                id: "fn1",
                kind: "Function" as const,
                span: { start_line: 1, start_col: 0, end_line: 10, end_col: 1 },
                signature: null,
                visibility: null,
                parent: "file1",
                children: [],
            },
        },
        edges: [],
        root: "root",
    };

    it("finds nodes matching query", () => {
        const matches = computeMatchingNodeIds(mockGraph, "parse");
        assert.ok(matches.has("fn1")); // direct match
    });

    it("includes ancestors of matching nodes", () => {
        const matches = computeMatchingNodeIds(mockGraph, "parse");
        assert.ok(matches.has("file1")); // ancestor of fn1
        assert.ok(matches.has("root")); // ancestor of file1
    });

    it("returns all node IDs for empty query", () => {
        const matches = computeMatchingNodeIds(mockGraph, "");
        assert.equal(matches.size, 3);
    });

    it("returns empty set for no matches", () => {
        const matches = computeMatchingNodeIds(mockGraph, "nonexistent_xyz");
        assert.equal(matches.size, 0);
    });

    it("handles whitespace-only query as empty", () => {
        const matches = computeMatchingNodeIds(mockGraph, "   ");
        assert.equal(matches.size, 3);
    });

    it("matches case-insensitively", () => {
        const matches = computeMatchingNodeIds(mockGraph, "PARSE");
        assert.ok(matches.has("fn1"));
    });

    it("matches directory names", () => {
        const matches = computeMatchingNodeIds(mockGraph, "src");
        assert.ok(matches.has("root"));
    });

    it("matches file names", () => {
        const matches = computeMatchingNodeIds(mockGraph, "utils");
        assert.ok(matches.has("file1"));
        assert.ok(matches.has("root")); // ancestor
    });
});
