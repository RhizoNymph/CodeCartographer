import { useEffect } from "react";
import { Toolbar } from "./toolbar/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { Canvas } from "./canvas/Canvas";
import { Tooltip } from "./canvas/Tooltip";
import { FocusBreadcrumb } from "./canvas/FocusBreadcrumb";
import { EdgeLegend } from "./canvas/legend/EdgeLegend";
import { SelectionChip } from "./canvas/SelectionChip";
import { useFocusHotkey } from "./canvas/useFocusHotkey";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useGraphStore } from "./stores/graphStore";

export function App() {
  const graph = useGraphStore((s) => s.graph);
  const isLoaded = graph !== null;
  const saveCurrentState = useGraphStore((s) => s.saveCurrentState);

  // "F" focuses the hovered (or selected) node from anywhere in the app.
  useFocusHotkey();

  // Save state when the app closes
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentState();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentState]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
      }}
    >
      <ErrorBoundary fallbackMessage="Toolbar error">
        <Toolbar />
      </ErrorBoundary>
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {isLoaded && (
          <ErrorBoundary fallbackMessage="Sidebar error">
            <Sidebar />
          </ErrorBoundary>
        )}
        {/* Canvas plus the overlays that belong to the canvas area rather than
            the whole workspace, so the legend anchors to the canvas's
            bottom-left corner and never sits over the sidebar. */}
        <div style={{ display: "flex", flex: 1, position: "relative", overflow: "hidden" }}>
          <ErrorBoundary fallbackMessage="Canvas failed to render">
            <Canvas />
          </ErrorBoundary>
          {isLoaded && (
            <ErrorBoundary fallbackMessage="Edge legend error">
              <EdgeLegend />
            </ErrorBoundary>
          )}
        </div>
        <Tooltip />
        <SelectionChip />
        <FocusBreadcrumb />
      </div>
    </div>
  );
}
