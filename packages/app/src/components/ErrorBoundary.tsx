import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
    children: ReactNode;
    fallbackMessage?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("ErrorBoundary caught:", error, info.componentStack);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: 24,
                    background: "#1e1e2e",
                    color: "#f87171",
                    borderRadius: 8,
                    margin: 8,
                    fontFamily: "monospace",
                }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                        {this.props.fallbackMessage || "Something went wrong"}
                    </div>
                    <pre style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "pre-wrap", marginBottom: 12 }}>
                        {this.state.error?.message}
                    </pre>
                    <button
                        onClick={() => this.setState({ hasError: false, error: null })}
                        style={{
                            padding: "6px 16px",
                            background: "#334155",
                            color: "#e2e8f0",
                            border: "1px solid #475569",
                            borderRadius: 4,
                            cursor: "pointer",
                            fontSize: 12,
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
