import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

// Prevent unhandled errors from silently crashing the webview
window.addEventListener("error", (e) => {
  console.error("Unhandled error:", e.error);
  document.body.innerHTML = `<pre style="color:#f87171;padding:40px;font-size:14px;">Unhandled error:\n${e.error?.stack || e.message}</pre>`;
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled rejection:", e.reason);
  document.body.innerHTML = `<pre style="color:#f87171;padding:40px;font-size:14px;">Unhandled promise rejection:\n${e.reason?.stack || e.reason}</pre>`;
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
