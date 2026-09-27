// Stages the server runtime that ships outside asar (resources/runtime):
//   node/            official Node.js 22 binary for this platform (SHA-256 checked against nodejs.org SHASUMS256.txt)
//   apps/server/     server sources + drizzle migrations
//   apps/web/dist/   prebuilt web app
//   scripts/seed-golden.ts
//   server-entry.ts  desktop entry (calls startServer; see ../runtime/server-entry.ts)
//   node_modules/    production dependency closure of the server, its workspace packages (materialised as real
//                    directories under node_modules/@vibread/*) and tsx — computed from package-lock.json, dev-only
//                    packages (vite, vitest, typescript, @types, MUI, React…) never enter the closure.
// Native modules are the ones `npm ci` installed on this machine, so each OS must stage its own build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.22.1";
// Pinned from https://nodejs.org/dist/v22.22.1/SHASUMS256.txt; the downloaded SHASUMS256.txt must agree.
const NODE_ASSETS = {
  "darwin-arm64": { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "679ad4966339e4ef4900f57996714864e4211b898825bb840c3086c419fbcef2", bin: "bin/node" },
  "darwin-x64": { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "07b13722d558790fca20bb1ecf61bde24b7a4863111f7be77fc57251a407359a", bin: "bin/node" },
  "linux-x64": { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "07c8aafa60644fb81adefa1ee7da860eb1920851ffdc9a37020ab0be47fbc10e", bin: "bin/node" },
  "win32-x64": { file: `node-v${NODE_VERSION}-win-x64.zip`, sha256: "877cb93829e14fffbbc7903e7d8037336c9a79f3ea43c5d0b8c2379b79da56de", bin: "node.exe" },
};

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(DESKTOP, "../..");
const CACHE = join(DESKTOP, ".cache");
const OUT = join(DESKTOP, ".stage", "runtime");
// Peers declared for typings/tooling only; nothing at runtime imports them.
const SKIP = [/^typescript$/, /^@types\//, /^vite$/, /^@biomejs\//];

const key = `${process.platform}-${process.arch}`;
const asset = NODE_ASSETS[key];
const PACKAGE_JUNK_DIRS = new Set(["test", "tests", "__tests__", "docs", "example", "examples", ".github", "site", "cosmos"]);
if (!asset) throw new Error(`no bundled Node.js for ${key}`);
if (process.versions.node !== NODE_VERSION) {
  console.warn(`warning: staging with Node ${process.versions.node}; native modules should be installed by Node ${NODE_VERSION}`);
}
if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) throw new Error("apps/web/dist is missing: run `npm run build` first");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await stageNode();
const copied = stageSources();
const packages = stageDependencies(join(ROOT, "package-lock.json"), ROOT, ["apps/server", "fixtures"], ["tsx"]);
pruneForeignBinaries();
const runtimeLock = join(ROOT, "packages/assembly/schematic-runtime");
const schematicPackages = stageDependencies(
  join(runtimeLock, "package-lock.json"),
  runtimeLock,
  [""],
  [],
  (location) => join(OUT, "node_modules/@vibread/assembly/schematic-runtime", location),
);
pruneForeignBinaries();
writeFileSync(join(OUT, "package.json"), `${JSON.stringify({ name: "vibread-runtime", private: true, type: "module" }, null, 2)}\n`);
console.log(`staged ${copied} source trees, ${packages} server packages, ${schematicPackages} schematic-runtime packages → ${relative(ROOT, OUT)} (${Math.round(sizeOf(OUT) / 1e6)} MB)`);

async function stageNode() {
  mkdirSync(CACHE, { recursive: true });
  const archive = join(CACHE, asset.file);
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
  const listed = sums.split("\n").find((line) => line.trim().endsWith(`  ${asset.file}`))?.split(/\s+/)[0];
  if (listed !== asset.sha256) throw new Error(`SHASUMS256.txt lists ${listed} for ${asset.file}, pinned ${asset.sha256}`);
  if (!existsSync(archive) || (await sha256(archive)) !== asset.sha256) {
    console.log(`downloading ${base}/${asset.file}`);
    const response = await fetchOk(`${base}/${asset.file}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const actual = await sha256(archive);
  if (actual !== asset.sha256) throw new Error(`${asset.file}: SHA-256 ${actual} does not match ${asset.sha256}`);
  const scratch = join(CACHE, "extract");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const top = asset.file.replace(/\.(tar\.gz|zip)$/, "");
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", scratch, `${top}/${asset.bin}`, `${top}/LICENSE`], { stdio: "inherit" });
  const nodeDir = join(OUT, "node");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  cpSync(join(scratch, top, asset.bin), join(nodeDir, "bin", basename(asset.bin)));
  cpSync(join(scratch, top, "LICENSE"), join(nodeDir, "LICENSE"));
  rmSync(scratch, { recursive: true, force: true });
  const version = execFileSync(join(nodeDir, "bin", basename(asset.bin)), ["--version"], { encoding: "utf8" }).trim();
  if (version !== `v${NODE_VERSION}`) throw new Error(`bundled node reports ${version}`);
  console.log(`bundled Node.js ${version} (${asset.file}, sha256 ok)`);
}

function stageSources() {
  const isRuntimeFile = (source) => {
    const name = basename(source);
    if (name === "node_modules" || name === "coverage" || name === ".turbo") return false;
    return !/\.test\.[cm]?[jt]sx?$/.test(name) && !name.endsWith(".tsbuildinfo");
  };
  const copies = [
    ["apps/server/package.json", "apps/server/package.json"],
    ["apps/server/src", "apps/server/src"],
    ["apps/server/drizzle", "apps/server/drizzle"],
    ["apps/web/dist", "apps/web/dist"],
    ["scripts/seed-golden.ts", "scripts/seed-golden.ts"],
    [relative(ROOT, join(DESKTOP, "runtime/server-entry.ts")), "server-entry.ts"],
    ["LICENSE", "LICENSE"],
  ];
  for (const [from, to] of copies) cpSync(join(ROOT, from), join(OUT, to), { recursive: true, filter: isRuntimeFile });
  const webVersion = join(ROOT, "apps/web/dist/version.json");
  const runtimeVersion = join(OUT, "apps/server/src/version.json");
  const version = existsSync(webVersion)
    ? readFileSync(webVersion, "utf8")
    : `${JSON.stringify({
        version: process.env.APP_VERSION?.trim() || "0.1.0-dev",
        commit: process.env.GITHUB_SHA?.trim().slice(0, 7) || "unknown",
        builtAt: process.env.VIBREAD_BUILT_AT?.trim() || new Date().toISOString(),
      })}\n`;
  writeFileSync(runtimeVersion, version);
  return copies.length;
}

/**
 * Copies the production closure of `roots` (lock locations) plus `extra` root-level packages, resolving each dependency
 * the way Node does (nearest node_modules walking up). Workspace links are materialised under node_modules/@vibread/*.
 */
function stageDependencies(lockPath, lockRoot, roots, extra, destination = mapLocation) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8")).packages;
  const seen = new Set();
  const queue = [...roots];
  for (const name of extra) queue.push(resolveDep(lock, "", name) ?? fail(`${name} is not installed`));
  while (queue.length) {
    const location = queue.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = lock[location];
    if (entry.link) {
      queue.push(entry.resolved);
      continue;
    }
    const names = [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}).filter((name) => !entry.peerDependenciesMeta?.[name]?.optional),
    ];
    for (const name of names) {
      if (SKIP.some((pattern) => pattern.test(name))) continue;
      const found = resolveDep(lock, location, name);
      if (found && existsSync(join(lockRoot, found))) queue.push(found);
      else if (entry.dependencies?.[name]) fail(`${location || "<root>"} depends on ${name}, which is not installed`);
    }
  }
  let count = 0;
  for (const location of [...seen].sort()) {
    const entry = lock[location];
    if (entry.link) continue;
    if (!location.includes("node_modules/") && location !== "") {
      // Workspace package (apps/server, packages/*, fixtures): sources only; its nested node_modules come from the lock.
      if (location === "apps/server") continue;
      const target = destination(location);
      cpSync(join(lockRoot, location), target, {
        recursive: true,
        filter: (source) => {
          const rel = relative(join(lockRoot, location), source).split(sep);
          if (rel[0] === "node_modules") return false;
          if (rel[0] === "schematic-runtime" && rel[1] === "node_modules") return false; // staged from its own lock
          return !/\.test\.[cm]?[jt]sx?$/.test(source);
        },
      });
      count += 1;
      continue;
    }
    if (location === "") continue;
    cpSync(join(lockRoot, location), destination(location), {
      recursive: true,
      // Nested node_modules are staged individually from the lock (keeps dev-only nested packages out); typings,
      // source maps and top-level test/doc folders are never loaded at runtime.
      filter: (source) => {
        const rel = relative(join(lockRoot, location), source).split(sep);
        if (rel.includes("node_modules")) return false;
        if (PACKAGE_JUNK_DIRS.has(rel[0])) return false;
        return !/\.(map|d\.[cm]?ts)$/.test(source);
      },
    });
    count += 1;
  }
  return count;
}

function resolveDep(lock, from, name) {
  let dir = from;
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (lock[candidate]) return candidate;
    if (!dir) return undefined;
    const parent = posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}

// packages/<name>/… and fixtures/… live under node_modules/@vibread/<name>/… so imports resolve without symlinks.
function mapLocation(location) {
  const [head, ...rest] = location.split("/");
  if (head === "packages" || head === "fixtures") {
    const workspaceDir = head === "packages" ? `packages/${rest.shift()}` : "fixtures";
    const name = JSON.parse(readFileSync(join(ROOT, workspaceDir, "package.json"), "utf8")).name;
    return join(OUT, "node_modules", ...name.split("/"), ...rest);
  }
  return join(OUT, location);
}

// Prebuilt binaries for other platforms (better-sqlite3 ships all of them) and native sources are dead weight.
function pruneForeignBinaries() {
  const sqlite = join(OUT, "node_modules/better-sqlite3");
  if (existsSync(sqlite)) {
    for (const file of readdirSync(join(sqlite, "prebuilds"))) {
      if (file !== `${key}.node`) rmSync(join(sqlite, "prebuilds", file));
    }
    for (const dir of ["deps", "src", "build"]) rmSync(join(sqlite, dir), { recursive: true, force: true });
  }
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function sizeOf(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

function fail(message) {
  throw new Error(message);
}
