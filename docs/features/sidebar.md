# Sidebar

## Scope
The sidebar displays the code graph as a tree with search filtering, checkbox visibility toggles,
and expand/collapse controls. It enables users to navigate and control which nodes appear on the canvas.

### In scope
- Tree rendering of CodeGraph nodes (directories, files, code blocks)
- Search filtering with `useDeferredValue` for non-blocking input
- Pre-computed matching node IDs via `computeMatchingNodeIds` (O(n) single pass)
- `React.memo` on TreeItem with custom comparator for render optimization
- Checkbox-driven visibility toggling (recursive)
- Expand/collapse state for container nodes
- Parse progress indicator

### Not in scope
- Canvas rendering (handled by canvas-rendering feature)
- Graph layout computation
- Drag-and-drop reordering

## Data/Control Flow
1. User types in the search input -- `searchInput` state updates immediately.
2. `useDeferredValue` produces `searchQuery` which may lag behind during rapid typing.
3. `useMemo` calls `computeMatchingNodeIds(graph, searchQuery)` to produce a `Set<string>` of matching node IDs plus their ancestors.
4. Root children are filtered by `matchingNodeIds.has(childId)` before rendering `TreeItem`.
5. Each `TreeItem` receives the `matchingNodeIds` set by reference. `React.memo` custom comparator checks reference equality, so the set only triggers re-renders when the `useMemo` produces a new instance.
6. TreeItem reads store selectors for `expandedNodes`, `visibleNodes`, `selectedNodeId` to render state.
7. User interactions (click, checkbox, chevron) dispatch to `graphStore` actions.

## Files
- `packages/app/src/sidebar/Sidebar.tsx` -- Main Sidebar component and memoized TreeItem
- `packages/app/src/sidebar/searchUtils.ts` -- `computeMatchingNodeIds` pure function
- `packages/app/tests/sidebar.test.ts` -- Unit tests for search utility

## Key Exports/Interfaces
- `Sidebar` -- React component (default export from Sidebar.tsx)
- `computeMatchingNodeIds(graph: CodeGraph, query: string): Set<string>` -- Pure search function

## Invariants
- `computeMatchingNodeIds` always returns ancestors of any matching node, ensuring the tree path is visible.
- Empty/whitespace query returns all node IDs (no filtering).
- `matchingNodeIds` set reference is stable across renders when inputs haven't changed (via `useMemo`).
- TreeItem custom comparator uses reference equality for `matchingNodeIds` to avoid deep comparison.
