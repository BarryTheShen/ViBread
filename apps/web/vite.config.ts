import { rmSync } from "node:fs";
import { resolve } from "node:path";
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

/** public/ holds the demo's service worker and recorded data; only the demo build (VITE_DEMO=1) ships them. */
function dropDemoFiles(): Plugin {
  let outDir = "";
  return {
    name: "vibread-drop-demo-files",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const name of ["demo-sw.js", "demo-data"]) rmSync(resolve(outDir, name), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const version = resolveBuildVersion(env);
  const target = env.VITE_API_TARGET || "http://localhost:8787";
  const proxied = { target, changeOrigin: false, ws: false, xfwd: true };
  return {
    base: env.VITE_BASE || "/",
    plugins: [react(), versionAsset(version), ...(env.VITE_DEMO === "1" ? [] : [dropDemoFiles()])],
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
    // The public demo ships without source maps: they would double the size of the Pages site.
    build: { outDir: "dist", sourcemap: env.VITE_DEMO !== "1", chunkSizeWarningLimit: 1500 },
  };
});

