import { memo } from "react";
import type { EdgeKind } from "../api/types";
import { EDGE_COLORS } from "../api/types";

interface Props {
    kind: EdgeKind;
    enabled: boolean;
    label: string;
    count: number;
    onToggle: (kind: EdgeKind) => void;
}

export const EdgeToggleButton = memo(function EdgeToggleButton({ kind, enabled, label, count, onToggle }: Props) {
    const color = EDGE_COLORS[kind];
    const isEmpty = count === 0;
    return (
        <button
            onClick={() => onToggle(kind)}
            title={`${kind} (${count})`}
            disabled={isEmpty}
            style={{
                padding: "2px 6px",
                fontSize: 10,
                border: `1px solid ${color}`,
                borderRadius: 4,
                cursor: isEmpty ? "default" : "pointer",
                background: enabled && !isEmpty ? color : "transparent",
                color: enabled && !isEmpty ? "white" : color,
                opacity: isEmpty ? 0.3 : enabled ? 1 : 0.5,
                pointerEvents: isEmpty ? "none" : "auto",
                whiteSpace: "nowrap",
            }}
        >
            {label} {count}
        </button>
    );
});
