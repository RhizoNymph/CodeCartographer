import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ParseEvent,
  ParseResult,
  SubGraph,
  Neighborhood,
  FocusDirection,
} from "./types";

export async function scanRepo(path: string): Promise<ParseResult> {
  return invoke<ParseResult>("scan_repo", { path });
}

export async function parseRepo(
  path: string,
  onEvent: (event: ParseEvent) => void
): Promise<ParseResult> {
  const channel = new Channel<ParseEvent>();
  channel.onmessage = onEvent;

  return invoke<ParseResult>("parse_repo", {
    path,
    onEvent: channel,
  });
}

/**
 * Fetch the direct + aggregated edges for a render view. `renderIds` are the
 * node ids present in the current ELK layout tree; `edgeKinds` is the set of
 * enabled edge-kind names.
 */
export async function getSubgraph(
  renderIds: string[],
  edgeKinds: string[]
): Promise<SubGraph> {
  return invoke<SubGraph>("get_subgraph", {
    renderIds,
    edgeKinds,
  });
}

/**
 * Fetch the local neighborhood around `nodeId` for focus / drill-down. BFS in
 * `direction` (callers, callees, or both) bounded by `depth` (1 or 2 hops),
 * filtered to `edgeKinds`. Returns the neighborhood node ids (incl. container
 * chain) and the direct edges among them.
 */
export async function getNeighborhood(
  nodeId: string,
  depth: number,
  edgeKinds: string[],
  direction: FocusDirection
): Promise<Neighborhood> {
  return invoke<Neighborhood>("get_neighborhood", {
    nodeId,
    depth,
    edgeKinds,
    direction,
  });
}

export async function cloneGithubRepo(url: string): Promise<string> {
  return invoke<string>("clone_github_repo", { url });
}

export async function checkNorestore(): Promise<boolean> {
  return invoke<boolean>("check_norestore");
}
