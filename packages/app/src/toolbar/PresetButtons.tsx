import { memo } from "react";
import type { EdgeKind } from "../api/types";

export interface Preset {
  name: string;
  label: string;
  edgeKinds: EdgeKind[];
  maxDepth: number | null;
  description: string;
}

export const PRESETS: Preset[] = [
  {
    name: "architecture",
    label: "Arch",
    edgeKinds: ["Import", "Inheritance", "TraitImpl"],
    maxDepth: 1,
    description: "Top-level module structure",
  },
  {
    name: "imports",
    label: "Imports",
    edgeKinds: ["Import"],
    maxDepth: 2,
    description: "Import dependencies only",
  },
  {
    name: "calls",
    label: "Calls",
    edgeKinds: ["FunctionCall", "MethodCall"],
    maxDepth: null,
    description: "Function and method call graph",
  },
  {
    name: "types",
    label: "Types",
    edgeKinds: ["TypeReference", "Inheritance", "TraitImpl"],
    maxDepth: null,
    description: "Type relationships",
  },
  {
    name: "publicApi",
    label: "Public",
    edgeKinds: [
      "Import",
      "FunctionCall",
      "MethodCall",
      "TypeReference",
      "Inheritance",
      "TraitImpl",
      "VariableUsage",
    ],
    maxDepth: null,
    description: "Public symbols only",
  },
];

interface Props {
  activePreset: string | null;
  onApplyPreset: (preset: Preset) => void;
}

export const PresetButtons = memo(function PresetButtons({
  activePreset,
  onApplyPreset,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 10, color: "#64748b", marginRight: 2 }}>
        Presets:
      </span>
      {PRESETS.map((preset) => {
        const isActive = activePreset === preset.name;
        return (
          <button
            key={preset.name}
            onClick={() => onApplyPreset(preset)}
            title={preset.description}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              border: "1px solid #475569",
              borderRadius: 4,
              cursor: "pointer",
              background: isActive ? "#475569" : "#334155",
              color: isActive ? "#e2e8f0" : "#94a3b8",
              fontWeight: isActive ? 600 : 400,
              whiteSpace: "nowrap",
            }}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
});
