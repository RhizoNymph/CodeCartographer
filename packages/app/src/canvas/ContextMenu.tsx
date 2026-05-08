import { useEffect, useCallback } from "react";
import { useGraphStore } from "../stores/graphStore";

interface MenuItemProps {
  label: string;
  onClick: () => void;
}

function MenuItem({ label, onClick }: MenuItemProps) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: 12,
        color: "#e2e8f0",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#334155";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </div>
  );
}

export function ContextMenu() {
  const contextMenu = useGraphStore((s) => s.contextMenu);
  const setContextMenu = useGraphStore((s) => s.setContextMenu);
  const graph = useGraphStore((s) => s.graph);
  const requestZoomToNode = useGraphStore((s) => s.requestZoomToNode);
  const expandSubtree = useGraphStore((s) => s.expandSubtree);
  const collapseSubtree = useGraphStore((s) => s.collapseSubtree);
  const hideSubtree = useGraphStore((s) => s.hideSubtree);
  const showOnlyDependencies = useGraphStore((s) => s.showOnlyDependencies);

  const dismiss = useCallback(() => {
    setContextMenu(null);
  }, [setContextMenu]);

  // Dismiss on outside click or Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleMouseDown = () => {
      dismiss();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
      }
    };

    // Use setTimeout so the current click that opened the menu doesn't dismiss it
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleMouseDown);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu, dismiss]);

  if (!contextMenu || !graph) return null;

  const node = graph.nodes[contextMenu.nodeId];
  if (!node) return null;

  const nodePath = "path" in node ? node.path : node.id;

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: contextMenu.screenX,
        top: contextMenu.screenY,
        background: "#1e293b",
        border: "1px solid #334155",
        borderRadius: 6,
        padding: "4px 0",
        zIndex: 200,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        minWidth: 160,
      }}
    >
      <MenuItem
        label="Focus Here"
        onClick={() => {
          requestZoomToNode(contextMenu.nodeId);
          dismiss();
        }}
      />
      <MenuItem
        label="Expand All"
        onClick={() => {
          expandSubtree(contextMenu.nodeId);
          dismiss();
        }}
      />
      <MenuItem
        label="Collapse All"
        onClick={() => {
          collapseSubtree(contextMenu.nodeId);
          dismiss();
        }}
      />
      <div style={{ height: 1, background: "#334155", margin: "4px 0" }} />
      <MenuItem
        label="Hide Subtree"
        onClick={() => {
          hideSubtree(contextMenu.nodeId);
          dismiss();
        }}
      />
      <MenuItem
        label="Show Only Dependencies"
        onClick={() => {
          showOnlyDependencies(contextMenu.nodeId);
          dismiss();
        }}
      />
      <div style={{ height: 1, background: "#334155", margin: "4px 0" }} />
      <MenuItem
        label="Copy Path"
        onClick={() => {
          navigator.clipboard.writeText(nodePath);
          dismiss();
        }}
      />
    </div>
  );
}
