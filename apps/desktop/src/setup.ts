import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARDUINOJSON, AVR_CORE, CLI_VERSION, installToolchain, toolchainPaths } from "../../../scripts/setup-toolchain.mjs";
import { childEnv, killTree, openLog, spawnRuntime, type DesktopPaths } from "./runtime.js";

export type SetupStep = "toolchain" | "seed";

export interface SetupProgress {
  step: SetupStep;
  message: string;
  /** 0..1 within the step when known. */
  fraction?: number;
  state?: "done" | "skipped";
}

// Bump a version to make existing installs redo that step on their next launch.
export const STEP_VERSIONS: Record<SetupStep, string> = {
  toolchain: `arduino-cli ${CLI_VERSION} + ${AVR_CORE} + ${ARDUINOJSON}`,
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

/** Steps still to run: never recorded, recorded for another version, or (toolchain) its arduino-cli has gone missing. */
export function pendingSteps(paths: DesktopPaths): SetupStep[] {
  const marker = readMarker(paths);
  const cliMissing = !existsSync(toolchainPaths(paths.toolchain).cli);
  return (Object.keys(STEP_VERSIONS) as SetupStep[]).filter((step) => marker.steps[step]?.version !== STEP_VERSIONS[step] || (step === "toolchain" && cliMissing));
}

/**
 * Runs every pending first-run step in order, recording each in setup.json when it succeeds. Returns ms per step.
 * `signal` (the app quitting) stops the downloads and kills the arduino-cli / seeding children.
 */
export async function runSetup(paths: DesktopPaths, steps: SetupStep[], onProgress: (progress: SetupProgress) => void, signal?: AbortSignal): Promise<Partial<Record<SetupStep, number>>> {
  const log = openLog(paths, "setup.log");
  const timings: Partial<Record<SetupStep, number>> = {};
  try {
    for (const step of steps) {
      const started = Date.now();
      log.write(`\n=== ${new Date().toISOString()} ${step}\n`);
      if (step === "toolchain") {
        await installToolchain({
          dir: paths.toolchain,
          onProgress: ({ message, fraction }) => onProgress({ step, message, fraction }),
          onLog: (line) => log.write(`${line}\n`),
          signal,
        });
      } else {
        await seedGolden(paths, (line) => log.write(`${line}\n`), onProgress, signal);
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


// Three golden designs plus the recorded real-model moon-lamp run (scripts/seed-golden.ts).
const EXAMPLE_COUNT = 4;

/** Creates the pre-warmed example missions with scripts/seed-golden.ts (full pipeline incl. firmware compile). */
export async function seedGolden(paths: DesktopPaths, onLog: (line: string) => void, onProgress: (progress: SetupProgress) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
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
  const stop = (reason: Error) => {
    if (child.pid !== undefined) killTree(child.pid);
    reject(reason);
  };
  const timer = setTimeout(() => stop(new Error("seeding the example missions timed out after 15 minutes")), 15 * 60_000);
  const onAbort = () => stop(new Error("seeding the example missions was cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", reject);
  child.once("exit", (code, killedBy) => {
    if (code === 0) resolve();
    else reject(new Error(`seeding failed (${killedBy ?? `exit ${code}`}): ${tail.trim().split("\n").slice(-6).join("\n")}`));
  });
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  onProgress({ step: "seed", message: "Example missions ready", fraction: 1 });
}
