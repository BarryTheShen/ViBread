import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const target = env.VITE_API_TARGET || process.env.VITE_API_TARGET || "http://localhost:8787";
  const proxied = { target, changeOrigin: false, ws: false };
  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": proxied,
        "/mcp": proxied,
        "/a2a": proxied,
        "/.well-known": proxied,
      },
    },
    preview: { host: "0.0.0.0", port: 5173 },
    build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
  };
});
