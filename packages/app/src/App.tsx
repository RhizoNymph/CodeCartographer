import { useEffect } from "react";
import { Toolbar } from "./toolbar/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { Canvas } from "./canvas/Canvas";
import { Tooltip } from "./canvas/Tooltip";
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
      <Toolbar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {isLoaded && <Sidebar />}
        <Canvas />
        <Tooltip />
      </div>
    </div>
  );
}
