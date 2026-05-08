import { useRepoActions } from "../hooks/useRepoActions";
import { getLastFolder } from "../stores/persistenceStore";

export function WelcomeScreen() {
  const {
    openAndScan,
    handleOpenFolder,
    handleCloneRepo,
    isCloning,
    showUrlInput,
    setShowUrlInput,
    repoUrl,
    setRepoUrl,
  } = useRepoActions();

  const lastFolder = getLastFolder();

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
      }}
    >
      <div
        style={{
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 16,
          padding: "48px 56px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          maxWidth: 480,
          width: "100%",
        }}
      >
        {/* Logo */}
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: "#60a5fa",
            letterSpacing: "-0.02em",
          }}
        >
          CodeCartographer
        </div>

        {/* Tagline */}
        <div
          style={{
            fontSize: 14,
            color: "#94a3b8",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Visualize and explore the structure of any codebase.
          <br />
          Open a local folder or clone from a URL to get started.
        </div>

        {/* Action buttons */}
        <div
          style={{
            display: "flex",
            gap: 12,
            width: "100%",
            marginTop: 8,
          }}
        >
          <button
            onClick={handleOpenFolder}
            disabled={isCloning}
            style={{
              flex: 1,
              padding: "14px 20px",
              background: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 10,
              cursor: isCloning ? "not-allowed" : "pointer",
              fontSize: 14,
              fontWeight: 600,
              opacity: isCloning ? 0.6 : 1,
              transition: "opacity 0.15s",
            }}
          >
            Open Folder
          </button>

          {showUrlInput ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <input
                type="text"
                placeholder="https://github.com/user/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCloneRepo()}
                autoFocus
                style={{
                  padding: "10px 14px",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  color: "#e2e8f0",
                  fontSize: 13,
                  outline: "none",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={handleCloneRepo}
                  disabled={isCloning}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    background: "#3b82f6",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    cursor: isCloning ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 500,
                    opacity: isCloning ? 0.6 : 1,
                  }}
                >
                  {isCloning ? "Cloning..." : "Clone"}
                </button>
                <button
                  onClick={() => setShowUrlInput(false)}
                  style={{
                    padding: "8px 12px",
                    background: "#334155",
                    color: "#e2e8f0",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowUrlInput(true)}
              disabled={isCloning}
              style={{
                flex: 1,
                padding: "14px 20px",
                background: "#334155",
                color: "#e2e8f0",
                border: "none",
                borderRadius: 10,
                cursor: isCloning ? "not-allowed" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                opacity: isCloning ? 0.6 : 1,
                transition: "opacity 0.15s",
              }}
            >
              Clone URL
            </button>
          )}
        </div>

        {/* Recent repo */}
        {lastFolder && (
          <div
            style={{
              width: "100%",
              marginTop: 8,
              paddingTop: 16,
              borderTop: "1px solid #334155",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 8,
              }}
            >
              Recent
            </div>
            <button
              onClick={() => openAndScan(lastFolder)}
              disabled={isCloning}
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 8,
                color: "#94a3b8",
                fontSize: 13,
                cursor: isCloning ? "not-allowed" : "pointer",
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                opacity: isCloning ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#3b82f6";
                e.currentTarget.style.color = "#e2e8f0";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#334155";
                e.currentTarget.style.color = "#94a3b8";
              }}
            >
              {lastFolder}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
