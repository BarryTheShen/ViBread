// After `vite build --outDir dist-demo` (VITE_DEMO=1): make the output ready for GitHub Pages.
// - 404.html = index.html, so deep links like /ViBread/m/<id>?panel=tryit load the app instead of a Pages 404;
// - .nojekyll, so Pages serves the files as they are;
// - the web manifest's icon paths relative to the site (they are root paths for the normal build).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "dist-demo");
const index = resolve(outDir, "index.html");
if (!existsSync(index)) throw new Error(`${index} is missing: run the demo build first`);

copyFileSync(index, resolve(outDir, "404.html"));
writeFileSync(resolve(outDir, ".nojekyll"), "");

const manifestPath = resolve(outDir, "manifest.webmanifest");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.start_url = ".";
  manifest.scope = ".";
  for (const icon of manifest.icons ?? []) icon.src = icon.src.replace(/^\//, "");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const required of ["demo-sw.js", "demo-data/manifest.json"]) {
  if (!existsSync(resolve(outDir, required))) throw new Error(`${required} is missing from ${outDir}: the demo would have no data`);
}
console.log(`demo ready in ${outDir} (404.html, .nojekyll)`);
