import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanRepo, parseRepo, cloneGithubRepo } from "../api/commands";
import { useGraphStore } from "../stores/graphStore";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

export function Toolbar() {
  const repoPath = useGraphStore((s) => s.repoPath);
  const graph = useGraphStore((s) => s.graph);
  const isParsing = useGraphStore((s) => s.isParsing);
  const enabledEdgeKinds = useGraphStore((s) => s.enabledEdgeKinds);
  const setRepoPath = useGraphStore((s) => s.setRepoPath);
  const setGraph = useGraphStore((s) => s.setGraph);
  const setIsParsing = useGraphStore((s) => s.setIsParsing);
  const handleParseEvent = useGraphStore((s) => s.handleParseEvent);
  const toggleEdgeKind = useGraphStore((s) => s.toggleEdgeKind);

  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);

  const openAndScan = useCallback(
    async (path: string) => {
      setRepoPath(path);
      try {
        const scannedGraph = await scanRepo(path);
        setGraph(scannedGraph);

        setIsParsing(true);
        const parsedGraph = await parseRepo(
          path,
          scannedGraph,
          handleParseEvent
        );
        setGraph(parsedGraph);
      } catch (err) {
        console.error("Failed to scan/parse repo:", err);
        alert(`Error: ${err}`);
      }
    },
    [setRepoPath, setGraph, setIsParsing, handleParseEvent]
  );

  const handleOpenFolder = async () => {
    const selected = await open({
      directory: true,
      title: "Select Repository",
    });

    if (selected) {
      await openAndScan(selected);
    }
  };

  const handleCloneRepo = async () => {
    if (!repoUrl.trim()) return;

    setIsCloning(true);
    try {
      const clonedPath = await cloneGithubRepo(repoUrl.trim());
      setShowUrlInput(false);
      setRepoUrl("");
      await openAndScan(clonedPath);
    } catch (err) {
      console.error("Failed to clone repo:", err);
      alert(`Clone failed: ${err}`);
    } finally {
      setIsCloning(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+O: Open folder
      if (e.ctrlKey && e.key === "o") {
        e.preventDefault();
        handleOpenFolder();
      }
      // Ctrl+G: GitHub clone
      if (e.ctrlKey && e.key === "g") {
        e.preventDefault();
        setShowUrlInput(true);
      }
      // Escape: close URL input
      if (e.key === "Escape") {
        setShowUrlInput(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      style={{
        height: 48,
        background: "#1e293b",
        borderBottom: "1px solid #334155",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 8,
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div
        style={{
          fontWeight: 700,
          fontSize: 15,
          color: "#60a5fa",
          marginRight: 8,
          whiteSpace: "nowrap",
        }}
      >
        CodeCartographer
      </div>

      {/* Open folder button */}
      <button
        onClick={handleOpenFolder}
        disabled={isParsing || isCloning}
        title="Open folder (Ctrl+O)"
        style={buttonStyle(isParsing || isCloning)}
      >
        Open Folder
      </button>

      {/* GitHub clone */}
      {showUrlInput ? (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            type="text"
            placeholder="https://github.com/user/repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCloneRepo()}
            autoFocus
            style={{
              padding: "5px 10px",
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 6,
              color: "#e2e8f0",
              fontSize: 12,
              width: 280,
              outline: "none",
            }}
          />
          <button
            onClick={handleCloneRepo}
            disabled={isCloning}
            style={buttonStyle(isCloning)}
          >
            {isCloning ? "Cloning..." : "Clone"}
          </button>
          <button
            onClick={() => setShowUrlInput(false)}
            style={{
              ...buttonStyle(false),
              background: "#334155",
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowUrlInput(true)}
          disabled={isParsing || isCloning}
          title="Clone from GitHub (Ctrl+G)"
          style={{
            ...buttonStyle(isParsing || isCloning),
            background: "#334155",
          }}
        >
          Clone URL
        </button>
      )}

      {/* Current path */}
      {repoPath && (
        <div
          style={{
            fontSize: 12,
            color: "#64748b",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 200,
          }}
        >
          {repoPath}
        </div>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Edge type toggles */}
      {graph && graph.edges.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 3,
            alignItems: "center",
            flexWrap: "nowrap",
            overflow: "hidden",
          }}
        >
          <span
            style={{ fontSize: 10, color: "#64748b", marginRight: 2 }}
          >
            Edges:
          </span>
          {ALL_EDGE_KINDS.map((kind) => (
            <button
              key={kind}
              onClick={() => toggleEdgeKind(kind)}
              title={kind}
              style={{
                padding: "2px 6px",
                fontSize: 10,
                border: `1px solid ${EDGE_COLORS[kind]}`,
                borderRadius: 4,
                cursor: "pointer",
                background: enabledEdgeKinds.has(kind)
                  ? EDGE_COLORS[kind]
                  : "transparent",
                color: enabledEdgeKinds.has(kind) ? "white" : EDGE_COLORS[kind],
                opacity: enabledEdgeKinds.has(kind) ? 1 : 0.5,
                whiteSpace: "nowrap",
              }}
            >
              {shortEdgeLabel(kind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    background: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    fontWeight: 500,
    opacity: disabled ? 0.6 : 1,
    whiteSpace: "nowrap",
  };
}

function shortEdgeLabel(kind: EdgeKind): string {
  switch (kind) {
    case "Import": return "Imp";
    case "FunctionCall": return "Call";
    case "MethodCall": return "Meth";
    case "TypeReference": return "Type";
    case "Inheritance": return "Ext";
    case "TraitImpl": return "Impl";
    case "VariableUsage": return "Var";
  }
}
