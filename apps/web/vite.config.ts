import { resolveBuildVersion, type BuildVersion } from "../server/src/version.js";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

function versionAsset(version: BuildVersion): Plugin {
  return {
    name: "vibread-version",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify(version)}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const version = resolveBuildVersion(env);
  const target = env.VITE_API_TARGET || "http://localhost:8787";
  const proxied = { target, changeOrigin: false, ws: false, xfwd: true };
  return {
    plugins: [react(), versionAsset(version)],
    define: {
      __VIBREAD_VERSION__: JSON.stringify(version.version),
      __VIBREAD_COMMIT__: JSON.stringify(version.commit),
      __VIBREAD_BUILT_AT__: JSON.stringify(version.builtAt),
    },
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

