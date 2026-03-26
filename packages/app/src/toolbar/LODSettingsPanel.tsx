import { memo } from "react";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";
import type { EdgeLODSettings } from "../stores/viewportStore";

const ALL_EDGE_KINDS: EdgeKind[] = [
    "Import",
    "FunctionCall",
    "MethodCall",
    "TypeReference",
    "Inheritance",
    "TraitImpl",
    "VariableUsage",
];

interface Props {
    settings: EdgeLODSettings;
    onSettingsChange: (settings: Partial<EdgeLODSettings>) => void;
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

export const LODSettingsPanel = memo(function LODSettingsPanel({ settings, onSettingsChange }: Props) {
    return (
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
                    checked={settings.showEdgesInMinimap}
                    onChange={(e) =>
                        onSettingsChange({ showEdgesInMinimap: e.target.checked })
                    }
                    style={{ accentColor: "#3b82f6" }}
                />
                Show edges at minimap zoom
            </label>

            {/* Minimap opacity slider */}
            <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                    Minimap opacity: {Math.round(settings.minimapOpacity * 100)}%
                </div>
                <input
                    type="range"
                    min="0"
                    max="100"
                    value={settings.minimapOpacity * 100}
                    onChange={(e) =>
                        onSettingsChange({ minimapOpacity: parseInt(e.target.value) / 100 })
                    }
                    style={{ width: "100%", accentColor: "#3b82f6" }}
                />
            </div>

            {/* Overview opacity slider */}
            <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                    Overview opacity: {Math.round(settings.overviewOpacity * 100)}%
                </div>
                <input
                    type="range"
                    min="0"
                    max="100"
                    value={settings.overviewOpacity * 100}
                    onChange={(e) =>
                        onSettingsChange({ overviewOpacity: parseInt(e.target.value) / 100 })
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
                                const newSet = new Set(settings.hideAtOverview);
                                if (newSet.has(kind)) {
                                    newSet.delete(kind);
                                } else {
                                    newSet.add(kind);
                                }
                                onSettingsChange({ hideAtOverview: newSet });
                            }}
                            title={`${settings.hideAtOverview.has(kind) ? "Show" : "Hide"} ${kind} at overview`}
                            style={{
                                padding: "2px 5px",
                                fontSize: 9,
                                border: `1px solid ${EDGE_COLORS[kind]}`,
                                borderRadius: 3,
                                cursor: "pointer",
                                background: settings.hideAtOverview.has(kind)
                                    ? EDGE_COLORS[kind]
                                    : "transparent",
                                color: settings.hideAtOverview.has(kind)
                                    ? "white"
                                    : EDGE_COLORS[kind],
                                opacity: settings.hideAtOverview.has(kind) ? 0.7 : 0.4,
                            }}
                        >
                            {shortEdgeLabel(kind)}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
});
