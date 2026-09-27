#!/usr/bin/env node
// Captures the static data for the read-only GitHub Pages demo (VITE_DEMO=1).
//
//   node scripts/capture-demo.mjs <server-url> <urls-file> [--mission <id>]
//
// Fetches every GET URL in <urls-file> (one `/api/...` path+query per line; blank lines and `#` comments ignored) from
// a running ViBread server and writes the bodies byte-for-byte to apps/web/public/demo-data/files/<sha256(url)[0:16]>,
// plus apps/web/public/demo-data/manifest.json, the lookup table apps/web/public/demo-sw.js answers `/api/...` from.
// URLs that appear as strings inside captured JSON (artifactUrls, step pictures, traces) are followed too, so every
// file the UI can link to is present. Listed URLs are stored with whatever status the server answered; followed URLs
// only when they answer 200. The live chat stream is never captured (the service worker answers it with 204).
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/web/public/demo-data");
/** Never captured: the SSE chat stream (the SW answers 204) and the server's own log (local paths, not demo content). */
const SKIP = [/\/chat\/stream$/, /^\/api\/debug\//];

function usage(message) {
  console.error(`${message}\nusage: node scripts/capture-demo.mjs <server-url> <urls-file> [--mission <id>]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const missionFlag = args.indexOf("--mission");
const missionId = missionFlag === -1 ? undefined : args.splice(missionFlag, 2)[1];
const [serverArg, urlsFile] = args;
if (!serverArg || !urlsFile) usage("missing arguments");
const server = new URL(serverArg);

/** Normalises a URL to the manifest key: exactly the pathname+search the browser requests. */
function keyOf(raw) {
  const url = new URL(raw, server);
  return url.pathname + url.search;
}

const listed = (await readFile(urlsFile, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map(keyOf)
  .filter((key) => key.startsWith("/api/"));
if (listed.length === 0) usage(`${urlsFile} lists no /api/ URLs`);

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(path.join(OUT_DIR, "files"), { recursive: true });

const entries = {};
const failed = [];
const seen = new Set();
const queue = listed.map((key) => ({ key, followed: false }));
let totalBytes = 0;

while (queue.length > 0) {
  const { key, followed } = queue.shift();
  if (seen.has(key) || SKIP.some((re) => re.test(new URL(key, server).pathname))) continue;
  seen.add(key);
  let response;
  try {
    response = await fetch(new URL(key, server), { redirect: "manual" });
  } catch (error) {
    failed.push(`${key} (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) {
    if (followed) continue;
    failed.push(`${key} (HTTP ${response.status})`);
  }
  const type = response.headers.get("content-type") ?? "application/octet-stream";
  const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
  await writeFile(path.join(OUT_DIR, "files", name), body);
  entries[key] = { file: `files/${name}`, type, status: response.status };
  totalBytes += body.length;
  if (type.includes("json")) {
    for (const match of body.toString("utf8").matchAll(/"(\/api\/[^"\\\s]+)"/g)) queue.push({ key: keyOf(match[1]), followed: true });
  }
}

const missions = entries["/api/missions"] ? JSON.parse(await readFile(path.join(OUT_DIR, entries["/api/missions"].file), "utf8")) : [];
const demoMission = missionId ?? (missions.length === 1 ? missions[0].id : undefined);
if (!demoMission) usage("could not tell the demo mission: /api/missions must list exactly one mission, or pass --mission <id>");

const sorted = Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]));
await writeFile(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify({ version: 1, missionId: demoMission, entries: sorted }, null, 2)}\n`);

console.log(`captured ${Object.keys(entries).length} entries, ${(totalBytes / 1024 / 1024).toFixed(2)} MB → ${path.relative(process.cwd(), OUT_DIR)}/manifest.json (mission ${demoMission})`);
if (failed.length > 0) console.log(`not 200 (stored with their status):\n  ${failed.join("\n  ")}`);
