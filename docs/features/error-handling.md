# Error Handling (React ErrorBoundary)

## Scope
React class-based ErrorBoundary component that catches rendering errors in child component
trees and displays a fallback UI with retry capability.

### In scope
- Catching React rendering errors via `getDerivedStateFromError` / `componentDidCatch`
- Displaying error message with customizable fallback text
- Retry button to clear error state and re-render children
- Wrapping Toolbar, Sidebar, and Canvas in App.tsx

### Not in scope
- Async error handling (promise rejections handled separately in main.tsx)
- Network error handling (handled by individual components)
- Logging to external services

## Data/Control Flow
1. A child component throws during rendering.
2. `getDerivedStateFromError` sets `hasError: true` and captures the `Error` object.
3. `componentDidCatch` logs the error and component stack to console.
4. Fallback UI renders with the error message and a Retry button.
5. Clicking Retry resets `hasError` to `false`, triggering a re-render of the children.

## Files
- `packages/app/src/components/ErrorBoundary.tsx` -- ErrorBoundary class component
- `packages/app/src/App.tsx` -- Wraps Toolbar, Sidebar, Canvas with ErrorBoundary instances

## Key Exports/Interfaces
- `ErrorBoundary` -- React class component; props: `children`, `fallbackMessage?`

## Invariants
- ErrorBoundary only catches errors during React rendering lifecycle (not event handlers or async code).
- Each major section (Toolbar, Sidebar, Canvas) is wrapped independently so a crash in one does not take down the others.
- The Tooltip component is intentionally NOT wrapped since tooltip rendering failures are non-critical.
