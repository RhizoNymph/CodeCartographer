import { memo } from "react";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";

interface Props {
    kind: EdgeKind;
    enabled: boolean;
    label: string;
    onToggle: (kind: EdgeKind) => void;
}

export const EdgeToggleButton = memo(function EdgeToggleButton({ kind, enabled, label, onToggle }: Props) {
    const color = EDGE_COLORS[kind];
    return (
        <button
            onClick={() => onToggle(kind)}
            title={kind}
            style={{
                padding: "2px 6px",
                fontSize: 10,
                border: `1px solid ${color}`,
                borderRadius: 4,
                cursor: "pointer",
                background: enabled ? color : "transparent",
                color: enabled ? "white" : color,
                opacity: enabled ? 1 : 0.5,
                whiteSpace: "nowrap",
            }}
        >
            {label}
        </button>
    );
});
