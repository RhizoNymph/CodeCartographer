import { useEffect } from "react";
import { Toolbar } from "./toolbar/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { Canvas } from "./canvas/Canvas";
import { Tooltip } from "./canvas/Tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { EdgeLegend } from "./components/EdgeLegend";
import { DetailsPanel } from "./panels/DetailsPanel";
import { useGraphStore } from "./stores/graphStore";

export function App() {
  const graph = useGraphStore((s) => s.graph);
  const isLoaded = graph !== null;
  const saveCurrentState = useGraphStore((s) => s.saveCurrentState);

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
      {isLoaded && (
        <ErrorBoundary fallbackMessage="Breadcrumbs error">
          <Breadcrumbs />
        </ErrorBoundary>
      )}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {isLoaded ? (
          <>
            <ErrorBoundary fallbackMessage="Sidebar error">
              <Sidebar />
            </ErrorBoundary>
            <ErrorBoundary fallbackMessage="Canvas failed to render">
              <Canvas />
            </ErrorBoundary>
            <Tooltip />
            <EdgeLegend />
            <ErrorBoundary fallbackMessage="Details panel error">
              <DetailsPanel />
            </ErrorBoundary>
          </>
        ) : (
          <WelcomeScreen />
        )}
      </div>
    </div>
  );
}
