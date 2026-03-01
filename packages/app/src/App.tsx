import { Toolbar } from "./toolbar/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { Canvas } from "./canvas/Canvas";
import { Tooltip } from "./canvas/Tooltip";
import { useGraphStore } from "./stores/graphStore";

export function App() {
  const isLoaded = useGraphStore((s) => s.graph !== null);

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
