import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanRepo, parseRepo, cloneGithubRepo } from "../api/commands";
import { useGraphStore } from "../stores/graphStore";
import { saveLastFolder } from "../stores/persistenceStore";

/**
 * Extracts repo open/scan/clone logic so it can be reused
 * across Toolbar and WelcomeScreen.
 */
export function useRepoActions() {
  const setRepoPath = useGraphStore((s) => s.setRepoPath);
  const setGraph = useGraphStore((s) => s.setGraph);
  const setIsParsing = useGraphStore((s) => s.setIsParsing);
  const handleParseEvent = useGraphStore((s) => s.handleParseEvent);

  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);

  const openAndScan = useCallback(
    async (path: string) => {
      setRepoPath(path);
      saveLastFolder(path);
      try {
        const scannedGraph = await scanRepo(path);
        console.log("Scanned graph edges:", scannedGraph.edges.length);
        setGraph(scannedGraph);

        setIsParsing(true);
        const parsedGraph = await parseRepo(path, handleParseEvent);
        setGraph(parsedGraph);
        setIsParsing(false);
      } catch (err) {
        console.error("Failed to scan/parse repo:", err);
        setIsParsing(false);
        alert(`Error: ${err}`);
      }
    },
    [setRepoPath, setGraph, setIsParsing, handleParseEvent]
  );

  const handleOpenFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      title: "Select Repository",
    });

    if (selected) {
      await openAndScan(selected);
    }
  }, [openAndScan]);

  const handleCloneRepo = useCallback(async () => {
    if (!repoUrl.trim()) return;

    setIsCloning(true);
    try {
      const clonedPath = await cloneGithubRepo(repoUrl.trim());
      setShowUrlInput(false);
      setRepoUrl("");
      await openAndScan(clonedPath);
    } catch (err) {
      console.error("Failed to clone repo:", err);
      alert(`Clone failed: ${err}`);
    } finally {
      setIsCloning(false);
    }
  }, [repoUrl, openAndScan]);

  return {
    openAndScan,
    handleOpenFolder,
    handleCloneRepo,
    isCloning,
    showUrlInput,
    setShowUrlInput,
    repoUrl,
    setRepoUrl,
  };
}
