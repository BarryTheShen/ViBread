import { createHash } from "node:crypto";
import { existsSync, readFileSync, chmodSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ARDUINOJSON, AVR_CORE, CLI_VERSION, installToolchain } from "../../../scripts/setup-toolchain.mjs";
import { childEnv, killTree, openLog, spawnRuntime, type DesktopPaths } from "./runtime.js";

export type SetupStep = "toolchain" | "omp" | "seed";

export interface SetupProgress {
  step: SetupStep;
  message: string;
  /** 0..1 within the step when known. */
  fraction?: number;
  state?: "done" | "skipped" | "unavailable";
}

export const OMP_VERSION = "18.3.2";
const OMP_RELEASE = `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}`;
// Published in https://github.com/can1357/oh-my-pi/releases/download/v18.3.2/SHA256SUMS.txt.
const OMP_ASSETS: Record<string, { file: string; sha256: string }> = {
  "linux-x64": { file: "omp-linux-x64", sha256: "8cbbcd4bea7a7b86116a13352f31e3778fd4d93df931036bb1771738b0702534" },
  "linux-arm64": { file: "omp-linux-arm64", sha256: "f56f4775abbf269c481c78799691eaa59a7d69644fa7d592c775e2c65f7b13da" },
  "darwin-x64": { file: "omp-darwin-x64", sha256: "695d3cfd3dc31198362f0be4344dfe64dcc4655fb9ef3316d94368ad7af294d6" },
  "darwin-arm64": { file: "omp-darwin-arm64", sha256: "9fccf2cdd7a472c93cb54d99d95d914c86b5f41652054e3cdd0b17c5d28393a6" },
  "win32-x64": { file: "omp-windows-x64.exe", sha256: "5d99fe5c11ec3ff1792e427c0e61eeb5a6c84670cadb65d023dd2f5eb8705f40" },
};

export function ompAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): { file: string; sha256: string } | undefined {
  return OMP_ASSETS[`${platform}-${arch}`];
}

// Bump a version to make existing installs redo that step on their next launch.
const STEP_VERSIONS: Record<SetupStep, string> = {
  toolchain: `arduino-cli ${CLI_VERSION} + ${AVR_CORE} + ${ARDUINOJSON}`,
  omp: `omp ${OMP_VERSION}`,
  seed: "golden-missions-1",
};

interface Marker {
  steps: Partial<Record<SetupStep, { version: string; at: string; ms: number }>>;
}

const markerFile = (paths: DesktopPaths) => join(paths.userData, "setup.json");

function readMarker(paths: DesktopPaths): Marker {
  try {
    return existsSync(markerFile(paths)) ? (JSON.parse(readFileSync(markerFile(paths), "utf8")) as Marker) : { steps: {} };
  } catch {
    return { steps: {} };
  }
}

export function pendingSteps(paths: DesktopPaths): SetupStep[] {
  const marker = readMarker(paths);
  return (Object.keys(STEP_VERSIONS) as SetupStep[]).filter((step) => {
    if (marker.steps[step]?.version !== STEP_VERSIONS[step]) return true;
    return step === "omp" && !existsSync(paths.ompBin);
  });
}

/** Runs every pending first-run step in order, recording each in setup.json when it succeeds. Returns ms per step. */
export async function runSetup(paths: DesktopPaths, steps: SetupStep[], onProgress: (progress: SetupProgress) => void): Promise<Partial<Record<SetupStep, number>>> {
  const log = openLog(paths, "setup.log");
  const timings: Partial<Record<SetupStep, number>> = {};
  try {
    for (const step of steps) {
      const started = Date.now();
      log.write(`\n=== ${new Date().toISOString()} ${step}\n`);
      try {
        if (step === "toolchain") {
          await installToolchain({
            dir: paths.toolchain,
            onProgress: ({ message, fraction }) => onProgress({ step, message, fraction }),
            onLog: (line) => log.write(`${line}\n`),
          });
        } else if (step === "omp") {
          await installOmp(paths, onProgress, (line) => log.write(`${line}\n`));
        } else {
          await seedGolden(paths, (line) => log.write(`${line}\n`), onProgress);
        }
      } catch (error) {
        if (step !== "omp") throw error;
        const detail = error instanceof Error ? error.message : String(error);
        log.write(`=== omp unavailable: ${detail}\n`);
        onProgress({ step, state: "unavailable", message: `Claude account helper unavailable (${detail}); API key login still works.` });
        timings[step] = Date.now() - started;
        continue;
      }
      timings[step] = Date.now() - started;
      const marker = readMarker(paths);
      marker.steps[step] = { version: STEP_VERSIONS[step], at: new Date().toISOString(), ms: timings[step] };
      writeFileSync(markerFile(paths), `${JSON.stringify(marker, null, 2)}\n`);
      log.write(`=== ${step} done in ${timings[step]} ms\n`);
    }
    return timings;
  } catch (error) {
    log.write(`=== failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    throw error;
  } finally {
    log.end();
  }
}

async function installOmp(paths: DesktopPaths, onProgress: (progress: SetupProgress) => void, onLog: (line: string) => void): Promise<void> {
  const asset = ompAsset();
  if (!asset) throw new Error(`No bundled omp ${OMP_VERSION} for ${process.platform}-${process.arch}.`);
  mkdirSync(paths.ompDir, { recursive: true });
  if (existsSync(paths.ompBin) && (await sha256File(paths.ompBin)) === asset.sha256) {
    if (process.platform !== "win32") chmodSync(paths.ompBin, 0o755);
    onProgress({ step: "omp", message: `oh-my-pi ${OMP_VERSION} already installed`, fraction: 1 });
    return;
  }
  if (existsSync(paths.ompBin)) rmSync(paths.ompBin, { force: true });

  const temporary = `${paths.ompBin}.download`;
  const url = `${OMP_RELEASE}/${asset.file}`;
  onLog(`Downloading ${url}`);
  onProgress({ step: "omp", message: `Downloading Claude account helper ${OMP_VERSION}`, fraction: 0 });
  try {
    await download(url, temporary, (fraction) => onProgress({ step: "omp", message: `Downloading Claude account helper ${OMP_VERSION}`, fraction }));
    const actual = await sha256File(temporary);
    if (actual !== asset.sha256) throw new Error(`omp ${OMP_VERSION}: SHA-256 mismatch (expected ${asset.sha256}, got ${actual})`);
    if (process.platform !== "win32") chmodSync(temporary, 0o755);
    renameSync(temporary, paths.ompBin);
    onProgress({ step: "omp", message: `Claude account helper ${OMP_VERSION} ready`, fraction: 1 });
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function download(url: string, destination: string, onFraction: (fraction: number) => void): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (total) onFraction(received / total);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Three golden designs plus the recorded real-model moon-lamp run (scripts/seed-golden.ts).
const EXAMPLE_COUNT = 4;

/** Creates the pre-warmed example missions with scripts/seed-golden.ts (full pipeline incl. firmware compile). */
export async function seedGolden(paths: DesktopPaths, onLog: (line: string) => void, onProgress: (progress: SetupProgress) => void): Promise<void> {
  onProgress({ step: "seed", message: "Building the example missions (checks, firmware, simulation, layout)", fraction: 0 });
  const child = spawnRuntime(paths, "scripts/seed-golden.ts", [], childEnv(paths, { ANTHROPIC_API_KEY: undefined, NODE_ENV: "production" }));
  child.stdin.end();
  let done = 0;
  let tail = "";
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    tail = (tail + text).slice(-4000);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      onLog(line);
      const created = /^(.+?): mission \S+ r\d+/.exec(line);
      if (created) {
        done += 1;
        onProgress({ step: "seed", message: `Example ${done}/${EXAMPLE_COUNT} ready: ${created[1]}`, fraction: done / (EXAMPLE_COUNT + 1) });
        if (done === EXAMPLE_COUNT) onProgress({ step: "seed", message: "Preparing bench fault dictionaries", fraction: EXAMPLE_COUNT / (EXAMPLE_COUNT + 1) });
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    if (child.pid !== undefined) killTree(child.pid);
    reject(new Error("seeding the example missions timed out after 15 minutes"));
  }, 15 * 60_000);
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`seeding failed (${signal ?? `exit ${code}`}): ${tail.trim().split("\n").slice(-6).join("\n")}`));
  });
  try {
    await promise;
  } finally {
    clearTimeout(timer);
  }
  onProgress({ step: "seed", message: "Example missions ready", fraction: 1 });
}
