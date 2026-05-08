import { useState, useRef, useEffect } from "react";
import {
  useVisualizationStore,
  type VisualizationMode,
  type HotspotMetric,
} from "../stores/visualizationStore";
import { useGraphStore } from "../stores/graphStore";

const MODE_OPTIONS: Array<{ value: VisualizationMode; label: string; description: string }> = [
  { value: "default", label: "Default", description: "Standard graph view" },
  { value: "overview", label: "Overview", description: "Directory/file level, aggregated edges" },
  { value: "architecture", label: "Architecture", description: "Top-level directory groups" },
  { value: "dependency", label: "Dependency", description: "Trace upstream/downstream flow" },
  { value: "hotspot", label: "Hotspot", description: "Color by metrics (fan-in, fan-out)" },
];

const HOTSPOT_METRICS: Array<{ value: HotspotMetric; label: string }> = [
  { value: "fanIn", label: "Fan-in" },
  { value: "fanOut", label: "Fan-out" },
  { value: "symbolCount", label: "Symbols" },
];

export function VisualizationModeSelector() {
  const mode = useVisualizationStore((s) => s.mode);
  const setMode = useVisualizationStore((s) => s.setMode);
  const hotspotMetric = useVisualizationStore((s) => s.hotspotMetric);
  const setHotspotMetric = useVisualizationStore((s) => s.setHotspotMetric);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const currentLabel = MODE_OPTIONS.find((o) => o.value === mode)?.label ?? "Default";

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 500,
          border: "1px solid #475569",
          borderRadius: 5,
          cursor: "pointer",
          background: mode !== "default" ? "#3b82f6" : "#334155",
          color: "#e2e8f0",
          display: "flex",
          alignItems: "center",
          gap: 4,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.7 }}>View:</span>
        {currentLabel}
        <span style={{ fontSize: 8, opacity: 0.6 }}>&#9662;</span>
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 8,
            padding: 4,
            zIndex: 100,
            minWidth: 200,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setMode(option.value);
                if (option.value !== "hotspot") {
                  setIsOpen(false);
                }
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "6px 10px",
                fontSize: 12,
                color: mode === option.value ? "#60a5fa" : "#cbd5e1",
                background: mode === option.value ? "#1e3a5f" : "transparent",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div style={{ fontWeight: 500 }}>{option.label}</div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                {option.description}
              </div>
            </button>
          ))}

          {/* Dependency mode hint */}
          {mode === "dependency" && !selectedNodeId && (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 10,
                color: "#f59e0b",
                borderTop: "1px solid #334155",
                marginTop: 4,
              }}
            >
              Select a node first to trace dependencies
            </div>
          )}

          {/* Hotspot metric sub-selector */}
          {mode === "hotspot" && (
            <div
              style={{
                borderTop: "1px solid #334155",
                marginTop: 4,
                paddingTop: 4,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#64748b",
                  padding: "2px 10px",
                  marginBottom: 2,
                }}
              >
                Metric:
              </div>
              {HOTSPOT_METRICS.map((metric) => (
                <button
                  key={metric.value}
                  onClick={() => {
                    setHotspotMetric(metric.value);
                    setIsOpen(false);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "4px 10px",
                    fontSize: 11,
                    color: hotspotMetric === metric.value ? "#60a5fa" : "#94a3b8",
                    background: hotspotMetric === metric.value ? "#1e3a5f" : "transparent",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {metric.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
