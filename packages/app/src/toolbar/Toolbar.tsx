import { useState, useEffect, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanRepo, parseRepo, cloneGithubRepo } from "../api/commands";
import { useGraphStore } from "../stores/graphStore";
import { useViewportStore } from "../stores/viewportStore";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";
import { saveLastFolder, getLastFolder } from "../stores/persistenceStore";

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

  const edgeLODSettings = useViewportStore((s) => s.edgeLODSettings);
  const setEdgeLODSettings = useViewportStore((s) => s.setEdgeLODSettings);

  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [showLODSettings, setShowLODSettings] = useState(false);

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
          scannedGraph,
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

  // Restore last opened folder on startup
  const startupRestoredRef = useRef(false);
  useEffect(() => {
    if (startupRestoredRef.current) return;
    startupRestoredRef.current = true;

    const lastFolder = getLastFolder();
    if (lastFolder) {
      console.log("Restoring last folder:", lastFolder);
      openAndScan(lastFolder).catch((err) => {
        console.warn("Failed to restore last folder:", err);
      });
    }
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
      // Escape: close URL input and LOD settings
      if (e.key === "Escape") {
        setShowUrlInput(false);
        setShowLODSettings(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close LOD settings when clicking outside
  const lodSettingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showLODSettings) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (lodSettingsRef.current && !lodSettingsRef.current.contains(e.target as Node)) {
        setShowLODSettings(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showLODSettings]);

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

          {/* LOD Settings button */}
          <div ref={lodSettingsRef} style={{ position: "relative", marginLeft: 8 }}>
            <button
              onClick={() => setShowLODSettings(!showLODSettings)}
              title="Edge visibility settings"
              style={{
                padding: "2px 8px",
                fontSize: 10,
                border: "1px solid #475569",
                borderRadius: 4,
                cursor: "pointer",
                background: showLODSettings ? "#475569" : "#334155",
                color: "#e2e8f0",
              }}
            >
              LOD
            </button>

            {/* LOD Settings dropdown */}
            {showLODSettings && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: 12,
                  zIndex: 100,
                  minWidth: 220,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", marginBottom: 10 }}>
                  Edge LOD Settings
                </div>

                {/* Show edges in minimap */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    color: "#94a3b8",
                    marginBottom: 10,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={edgeLODSettings.showEdgesInMinimap}
                    onChange={(e) =>
                      setEdgeLODSettings({ showEdgesInMinimap: e.target.checked })
                    }
                    style={{ accentColor: "#3b82f6" }}
                  />
                  Show edges at minimap zoom
                </label>

                {/* Minimap opacity slider */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                    Minimap opacity: {Math.round(edgeLODSettings.minimapOpacity * 100)}%
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={edgeLODSettings.minimapOpacity * 100}
                    onChange={(e) =>
                      setEdgeLODSettings({ minimapOpacity: parseInt(e.target.value) / 100 })
                    }
                    style={{ width: "100%", accentColor: "#3b82f6" }}
                  />
                </div>

                {/* Overview opacity slider */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                    Overview opacity: {Math.round(edgeLODSettings.overviewOpacity * 100)}%
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={edgeLODSettings.overviewOpacity * 100}
                    onChange={(e) =>
                      setEdgeLODSettings({ overviewOpacity: parseInt(e.target.value) / 100 })
                    }
                    style={{ width: "100%", accentColor: "#3b82f6" }}
                  />
                </div>

                {/* Hide at overview */}
                <div>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                    Hide at overview zoom:
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {ALL_EDGE_KINDS.map((kind) => (
                      <button
                        key={kind}
                        onClick={() => {
                          const newSet = new Set(edgeLODSettings.hideAtOverview);
                          if (newSet.has(kind)) {
                            newSet.delete(kind);
                          } else {
                            newSet.add(kind);
                          }
                          setEdgeLODSettings({ hideAtOverview: newSet });
                        }}
                        title={`${edgeLODSettings.hideAtOverview.has(kind) ? "Show" : "Hide"} ${kind} at overview`}
                        style={{
                          padding: "2px 5px",
                          fontSize: 9,
                          border: `1px solid ${EDGE_COLORS[kind]}`,
                          borderRadius: 3,
                          cursor: "pointer",
                          background: edgeLODSettings.hideAtOverview.has(kind)
                            ? EDGE_COLORS[kind]
                            : "transparent",
                          color: edgeLODSettings.hideAtOverview.has(kind)
                            ? "white"
                            : EDGE_COLORS[kind],
                          opacity: edgeLODSettings.hideAtOverview.has(kind) ? 0.7 : 0.4,
                        }}
                      >
                        {shortEdgeLabel(kind)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
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
