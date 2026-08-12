import { useEffect, useRef, useState } from "react";
import { getNodeDetails } from "./commands";
import type { NodeDetails } from "./types";

/**
 * Selection and hover both move faster than an IPC round-trip, so let the
 * pointer/selection settle before asking for details.
 */
const DETAILS_DEBOUNCE_MS = 120;

/**
 * Lazily fetch the per-node facts the bulk parse payload omits (the block
 * signature) for `nodeId`.
 *
 * Debounced and stale-guarded exactly like the details panel's neighborhood
 * fetch: a monotonic request token means a response is applied only while it is
 * still the one being waited on, so arrow-keying the sidebar or sweeping the
 * pointer across nodes can never paint an earlier node's signature onto a later
 * one. Returns `null` until the answer for the CURRENT id arrives; a failed
 * fetch also yields `null` (details are supplementary -- their absence hides a
 * line, it does not break the surface showing it).
 */
export function useNodeDetails(nodeId: string | null): NodeDetails | null {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setDetails(null);

    if (!nodeId) return;

    const timer = setTimeout(() => {
      getNodeDetails(nodeId)
        .then((result) => {
          if (requestId !== requestIdRef.current) return; // stale -- discard
          setDetails(result);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return; // stale -- discard
          setDetails(null);
        });
    }, DETAILS_DEBOUNCE_MS);

    return () => {
      // Supersede the in-flight request so its response is dropped.
      requestIdRef.current += 1;
      clearTimeout(timer);
    };
  }, [nodeId]);

  return details;
}
