import { invoke, Channel } from "@tauri-apps/api/core";
import type { CodeGraph, ParseEvent, SubGraph } from "./types";

export async function scanRepo(path: string): Promise<CodeGraph> {
  return invoke<CodeGraph>("scan_repo", { path });
}

export async function parseRepo(
  path: string,
  onEvent: (event: ParseEvent) => void
): Promise<CodeGraph> {
  const channel = new Channel<ParseEvent>();
  channel.onmessage = onEvent;

  return invoke<CodeGraph>("parse_repo", {
    path,
    onEvent: channel,
  });
}

export async function getSubgraph(
  visibleIds: string[],
  edgeKinds: string[]
): Promise<SubGraph> {
  return invoke<SubGraph>("get_subgraph", {
    visibleIds,
    edgeKinds,
  });
}

export async function cloneGithubRepo(url: string): Promise<string> {
  return invoke<string>("clone_github_repo", { url });
}

export async function checkNorestore(): Promise<boolean> {
  return invoke<boolean>("check_norestore");
}
