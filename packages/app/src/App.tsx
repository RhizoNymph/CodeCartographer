import { useEffect } from "react";
import { Toolbar } from "./toolbar/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { Canvas } from "./canvas/Canvas";
import { Tooltip } from "./canvas/Tooltip";
import { DependencyPanel } from "./panels/DependencyPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useGraphStore } from "./stores/graphStore";
import { useVisualizationStore } from "./stores/visualizationStore";

export function App() {
  const graph = useGraphStore((s) => s.graph);
  const isLoaded = graph !== null;
  const saveCurrentState = useGraphStore((s) => s.saveCurrentState);
  const mode = useVisualizationStore((s) => s.mode);
  const dependencyFlow = useVisualizationStore((s) => s.dependencyFlow);

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
        <ErrorBoundary fallbackMessage="Canvas failed to render">
          <Canvas />
        </ErrorBoundary>
        {mode === "dependency" && dependencyFlow && <DependencyPanel />}
        <Tooltip />
      </div>
    </div>
  );
}
