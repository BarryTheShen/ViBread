// Bundles the Electron main process + preload (esbuild, CommonJS) and renders the app icon from the web app's SVG.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Resvg } from "@resvg/resvg-js";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(DESKTOP, "../..");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "info",
  // setup-toolchain.mjs checks import.meta.url to detect CLI use; in the bundle it is never the CLI.
  define: { "import.meta.url": "undefined" },
};
await build({ ...common, entryPoints: { main: join(DESKTOP, "src/main.ts") }, outdir: join(DESKTOP, "dist"), outExtension: { ".js": ".cjs" } });
await build({ ...common, entryPoints: { preload: join(DESKTOP, "src/preload.ts") }, outdir: join(DESKTOP, "dist"), outExtension: { ".js": ".cjs" } });

// One 1024 px PNG: electron-builder derives the macOS .icns and Windows .ico from build/icon.png; windows use static/icon.png.
const svg = readFileSync(join(ROOT, "apps/web/public/icon.svg"));
for (const [file, size] of [[join(DESKTOP, "build/icon.png"), 1024], [join(DESKTOP, "static/icon.png"), 256]]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}
console.log("icons rendered from apps/web/public/icon.svg");
