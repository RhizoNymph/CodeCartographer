import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // web-worker is a Node-only optional dep of elkjs; silence the warning
      external: ["web-worker"],
      output: {
        manualChunks: {
          pixi: ["pixi.js"],
          elk: ["elkjs/lib/elk.bundled.js"],
          vendor: ["react", "react-dom", "zustand"],
        },
      },
    },
  },
});
