import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanRepo, parseRepo, cloneGithubRepo } from "../api/commands";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import { useHistoryStore } from "../stores/historyStore";
import type { EdgeKind } from "../api/types";
import type { ViewMode } from "../stores/viewportStore";
import { saveLastFolder, getLastFolder, clearLastFolder } from "../stores/persistenceStore";
import { checkNorestore } from "../api/commands";
import { EdgeToggleButton } from "./EdgeToggleButton";
import { ViewSettingsPanel } from "./ViewSettingsPanel";
import { PresetButtons } from "./PresetButtons";
import type { Preset } from "./PresetButtons";

const ALL_EDGE_KINDS: EdgeKind[] = [
  "Import",
  "FunctionCall",
  "MethodCall",
  "TypeReference",
  "Inheritance",
  "TraitImpl",
  "VariableUsage",
];

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  full: "Full Detail",
  files: "Files",
  folders: "Folders",
  overview: "Overview",
};

export function Toolbar() {
  const repoPath = useGraphStore((s) => s.repoPath);
  const graph = useGraphStore((s) => s.graph);
  const isParsing = useGraphStore((s) => s.isParsing);
  const enabledEdgeKinds = useGraphStore((s) => s.enabledEdgeKinds);
  const activePreset = useGraphStore((s) => s.activePreset);
  const hideUnconnectedNodes = useGraphStore((s) => s.hideUnconnectedNodes);
  const setRepoPath = useGraphStore((s) => s.setRepoPath);
  const setGraph = useGraphStore((s) => s.setGraph);
  const setIsParsing = useGraphStore((s) => s.setIsParsing);
  const handleParseEvent = useGraphStore((s) => s.handleParseEvent);
  const toggleEdgeKind = useGraphStore((s) => s.toggleEdgeKind);
  const setHideUnconnectedNodes = useGraphStore((s) => s.setHideUnconnectedNodes);
  const applyPreset = useGraphStore((s) => s.applyPreset);
  const applySnapshot = useGraphStore((s) => s.applySnapshot);
  const getGraphViewSnapshot = useGraphStore((s) => s.getGraphViewSnapshot);

  const edgeLODSettings = useViewportStore((s) => s.edgeLODSettings);
  const setEdgeLODSettings = useViewportStore((s) => s.setEdgeLODSettings);
  const viewMode = useViewportStore((s) => s.viewMode);
  const setViewMode = useViewportStore((s) => s.setViewMode);

  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);

  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [showViewSettings, setShowViewSettings] = useState(false);

  // Compute edge counts
  const edgeCounts = useMemo(() => {
    if (!graph) return new Map<EdgeKind, number>();
    const counts = new Map<EdgeKind, number>();
    for (const edge of graph.edges) {
      counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  const openAndScan = useCallback(
    async (path: string) => {
      setRepoPath(path);
      saveLastFolder(path);
      try {
        const scannedGraph = await scanRepo(path);
        console.log("Scanned graph edges:", scannedGraph.edges.length);
        setGraph(scannedGraph);

        setIsParsing(true);
        const parsedGraph = await parseRepo(
          path,
          handleParseEvent
        );
        setGraph(parsedGraph);
        setIsParsing(false);
      } catch (err) {
        console.error("Failed to scan/parse repo:", err);
        setIsParsing(false);
        alert(`Error: ${err}`);
      }
    },
    [setRepoPath, setGraph, setIsParsing, handleParseEvent]
  );

  // Restore last opened folder on startup (unless --norestore flag was passed)
  const startupRestoredRef = useRef(false);
  useEffect(() => {
    if (startupRestoredRef.current) return;
    startupRestoredRef.current = true;

    checkNorestore().then((norestore) => {
      if (norestore) {
        console.log("--norestore flag detected, clearing saved folder");
        clearLastFolder();
        return;
      }

      const lastFolder = getLastFolder();
      if (lastFolder) {
        console.log("Restoring last folder:", lastFolder);
        openAndScan(lastFolder).catch((err) => {
          console.warn("Failed to restore last folder:", err);
        });
      }
    }).catch((err) => {
      console.warn("Failed to check norestore flag:", err);
    });
  }, [openAndScan]);

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

  const handleUndo = useCallback(() => {
    const snapshot = undo(getGraphViewSnapshot());
    if (snapshot) {
      applySnapshot(snapshot);
    }
  }, [undo, applySnapshot, getGraphViewSnapshot]);

  const handleRedo = useCallback(() => {
    const snapshot = redo(getGraphViewSnapshot());
    if (snapshot) {
      applySnapshot(snapshot);
    }
  }, [redo, applySnapshot, getGraphViewSnapshot]);

  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      applyPreset(preset);
    },
    [applyPreset]
  );

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
      // Ctrl+Z: Undo
      if (e.ctrlKey && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
      }
      // Ctrl+Shift+Z: Redo
      if (e.ctrlKey && e.shiftKey && e.key === "Z") {
        e.preventDefault();
        handleRedo();
      }
      // Escape: close URL input and view settings
      if (e.key === "Escape") {
        setShowUrlInput(false);
        setShowViewSettings(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  // Close view settings when clicking outside
  const viewSettingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showViewSettings) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (viewSettingsRef.current && !viewSettingsRef.current.contains(e.target as Node)) {
        setShowViewSettings(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showViewSettings]);

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

      {/* Controls section (only shown when graph is loaded) */}
      {graph && graph.edges.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "nowrap",
            overflow: "hidden",
          }}
        >
          {/* Presets */}
          <PresetButtons
            activePreset={activePreset}
            onApplyPreset={handleApplyPreset}
          />

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: "#334155" }} />

          <label
            title="Hide nodes that are not connected by the currently enabled edge types"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: "#cbd5e1",
              whiteSpace: "nowrap",
              marginRight: 8,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={hideUnconnectedNodes}
              onChange={(e) => setHideUnconnectedNodes(e.currentTarget.checked)}
              style={{
                cursor: "pointer",
                width: 13,
                height: 13,
                margin: 0,
              }}
            />
            Hide unconnected
          </label>

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: "#334155" }} />

          {/* Undo/Redo */}
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              style={undoRedoStyle(!canUndo)}
            >
              &#x2190;
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              style={undoRedoStyle(!canRedo)}
            >
              &#x2192;
            </button>
          </div>

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: "#334155" }} />

          {/* Edge type toggles */}
          <div
            style={{
              display: "flex",
              gap: 3,
              alignItems: "center",
              flexWrap: "nowrap",
            }}
          >
            <span
              style={{ fontSize: 10, color: "#64748b", marginRight: 2 }}
            >
              Edges:
            </span>
            {ALL_EDGE_KINDS.map((kind) => (
              <EdgeToggleButton
                key={kind}
                kind={kind}
                enabled={enabledEdgeKinds.has(kind)}
                label={shortEdgeLabel(kind)}
                count={edgeCounts.get(kind) ?? 0}
                onToggle={toggleEdgeKind}
              />
            ))}
          </div>

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: "#334155" }} />

          {/* View mode dropdown */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#64748b" }}>View:</span>
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as ViewMode)}
              style={{
                padding: "2px 6px",
                fontSize: 10,
                background: "#334155",
                color: "#e2e8f0",
                border: "1px solid #475569",
                borderRadius: 4,
                cursor: "pointer",
                outline: "none",
              }}
            >
              {(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {VIEW_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>

          {/* View settings gear button */}
          <div ref={viewSettingsRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowViewSettings(!showViewSettings)}
              title="Edge visibility settings"
              style={{
                padding: "2px 8px",
                fontSize: 12,
                border: "1px solid #475569",
                borderRadius: 4,
                cursor: "pointer",
                background: showViewSettings ? "#475569" : "#334155",
                color: "#e2e8f0",
                lineHeight: 1,
              }}
            >
              &#x2699;
            </button>

            {/* View Settings dropdown */}
            {showViewSettings && (
              <ViewSettingsPanel
                settings={edgeLODSettings}
                onSettingsChange={setEdgeLODSettings}
              />
            )}
          </div>
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

function undoRedoStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "2px 6px",
    fontSize: 12,
    border: "1px solid #475569",
    borderRadius: 4,
    cursor: disabled ? "default" : "pointer",
    background: "#334155",
    color: disabled ? "#475569" : "#e2e8f0",
    opacity: disabled ? 0.5 : 1,
    lineHeight: 1,
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
