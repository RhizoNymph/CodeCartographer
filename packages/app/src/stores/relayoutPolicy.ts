import type { CodeNode } from "../api/types";
import type { ViewMode } from "./graphViewModel";

/**
 * The relayout trigger policy: given a state change, how much of the render
 * pipeline actually has to re-run.
 *
 * The pipeline has three costs, from most to least expensive:
 *   - "full"       ELK layout of the whole node tree + a `get_subgraph` fetch.
 *                  The only phase that produces node POSITIONS.
 *   - "edges"      `get_subgraph` fetch + edge rebuild against the CACHED node
 *                  positions. No ELK run.
 *   - "visibility" flip the visibility of already-laid-out node displays and
 *                  redraw edges. No IPC, no ELK.
 *   - "none"       the change cannot affect what is on screen at all.
 *
 * The rule is: run a full layout only when the node-position problem actually
 * changed (the node set or the containment tree), and never more than once per
 * user action. Everything else takes the cheapest sufficient path.
 *
 * This module is intentionally dependency-free (type-only imports) so the policy
 * is unit-testable without the zustand/Pixi/Tauri runtime.
 */

export type LayoutWork = "none" | "visibility" | "edges" | "full";

/** The parts of the view state that change what a given action costs. */
export interface LayoutContext {
  /** Module view derives {Import} kinds and collapsed files from the raw state. */
  viewMode: ViewMode;
  /**
   * True when a focus frame is on screen. The focused view derives BOTH its
   * visible and expanded sets from the fetched frame payload, so the user's
   * expansion/visibility/hide-unconnected state has no effect on it.
   */
  focusActive: boolean;
  /**
   * True when unconnected nodes are filtered out. This makes the NODE set a
   * function of the enabled edge kinds, which promotes edge-kind toggles from
   * an edge-phase change to a full layout.
   */
  hideUnconnectedNodes: boolean;
}

/** A state change that could require layout work. */
export type GraphChange =
  /** A freshly parsed graph replaced the old one. */
  | { kind: "graph-replaced" }
  /** A container was expanded or collapsed (`nodeType` null when unknown). */
  | { kind: "expansion"; nodeType: CodeNode["type"] | null }
  /** A sidebar visibility checkbox flipped; `showing` is the direction. */
  | { kind: "visibility"; showing: boolean }
  /** An edge kind was enabled or disabled (edge legend row). */
  | { kind: "edge-kinds" }
  /** The hide-ambiguous-edges toggle flipped. */
  | { kind: "hide-ambiguous" }
  /** The hide-unconnected-nodes toggle flipped. */
  | { kind: "hide-unconnected" }
  /** The Module|Symbol view-mode control changed. */
  | { kind: "view-mode" }
  /** A focus frame was pushed, popped, refetched or cleared. */
  | { kind: "focus" }
  /** The explicit "Apply Layout Changes" button. */
  | { kind: "relayout-requested" };

export function layoutWorkFor(
  change: GraphChange,
  ctx: LayoutContext
): LayoutWork {
  switch (change.kind) {
    // Topology changes: a different node set or containment tree.
    case "graph-replaced":
    case "view-mode":
    case "focus":
      return "full";

    // The user explicitly asked for a fresh layout of the current state.
    case "relayout-requested":
      return "full";

    case "hide-unconnected":
      // Focus derives its visible set from the frame payload; the filter is not
      // applied there, so flipping it changes nothing on screen.
      return ctx.focusActive ? "none" : "full";

    case "expansion":
      if (ctx.focusActive) return "none";
      // Module view lays files out collapsed no matter what the saved expansion
      // says, so only Directory expansion reaches the ELK tree.
      if (ctx.viewMode === "module" && change.nodeType !== null) {
        return change.nodeType === "Directory" ? "full" : "none";
      }
      return "full";

    case "visibility":
      if (ctx.focusActive) return "none";
      // Hiding only ever removes already-laid-out nodes -> the cheap path.
      // Showing can reveal nodes that were never given a position.
      return change.showing ? "full" : "visibility";

    case "edge-kinds":
      // Module view forces {Import}; the toggles are not even reachable there.
      if (ctx.viewMode === "module") return "none";
      // With unconnected nodes filtered, the kinds decide which nodes survive.
      if (ctx.hideUnconnectedNodes && !ctx.focusActive) return "full";
      return "edges";

    case "hide-ambiguous":
      // A pure client-side edge filter. Module view only shows exact Import
      // edges, so it has nothing to filter.
      return ctx.viewMode === "module" ? "none" : "edges";
  }
}

/**
 * Whether this work leaves the node positions optimised for a stale input --
 * i.e. whether the "Apply Layout Changes" affordance should be offered. Edge and
 * visibility changes deliberately keep the existing positions.
 */
export function marksLayoutStale(work: LayoutWork): boolean {
  return work === "edges" || work === "visibility";
}

/**
 * The layout trigger counters held by the graph store. `layoutVersion` drives
 * the ELK positions phase and `edgeVersion` the edge-only phase; the canvas
 * watches exactly one of them per effect, so one bump == one pass.
 */
export interface LayoutTriggers {
  layoutVersion: number;
  edgeVersion: number;
  needsRelayout: boolean;
}

/**
 * Fold the decided work into the trigger counters. At most ONE version is ever
 * bumped, which is what guarantees a single layout pass per user action.
 */
export function applyLayoutWork(
  work: LayoutWork,
  cur: LayoutTriggers
): LayoutTriggers {
  switch (work) {
    case "full":
      return {
        layoutVersion: cur.layoutVersion + 1,
        edgeVersion: cur.edgeVersion,
        needsRelayout: false,
      };
    case "edges":
      return {
        layoutVersion: cur.layoutVersion,
        edgeVersion: cur.edgeVersion + 1,
        needsRelayout: true,
      };
    case "visibility":
      return { ...cur, needsRelayout: true };
    case "none":
      return cur;
  }
}
