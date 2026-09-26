import { Worker } from "node:worker_threads";
import type { Circuit, Layout, MissionStore, SelfTestPlan } from "@vibread/core";
import type { FaultDictionary } from "@vibread/bench";
import { SYSTEM_ACTOR, errorMessage } from "./common.js";
import type { FaultWorkerRequest } from "./faults-worker.js";

/** Artifact key of the single-fault dictionary (PLAN item 14) on a revision. */
export const FAULTS_ARTIFACT = "faults.json";
/** Mutants simulated per revision (FAULT_IDS × applicable parts is capped by @vibread/bench as well). */
const MAX_FAULTS = 40;
/** A dictionary that takes longer than this is abandoned (the diagnosis falls back to the rule table). */
const WORKER_TIMEOUT_MS = 180_000;

/** pino-compatible subset; the pipeline logs background failures instead of surfacing them as findings. */
export interface BackgroundLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface FaultJob {
  missionId: string;
  n: number;
  circuit: Circuit;
  layout: Layout;
  plan: SelfTestPlan;
  benchHex: string;
}

function runWorker(request: FaultWorkerRequest): Promise<FaultDictionary> {
  const source = new URL("./faults-worker.ts", import.meta.url).pathname.endsWith(".ts");
  const worker = source
    ? new Worker(new URL("./faults-worker-loader.mjs", import.meta.url), { execArgv: ["--import", import.meta.resolve("tsx/esm")] })
    : new Worker(new URL("./faults-worker.js", import.meta.url));
  worker.unref(); // background work never keeps a process (tests, seed scripts) alive
  return new Promise<FaultDictionary>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`fault dictionary timed out after ${WORKER_TIMEOUT_MS / 1000} s`));
    }, WORKER_TIMEOUT_MS);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once("message", (message: { ok: true; dictionary: FaultDictionary } | { ok: false; error: string }) => {
      done();
      if (message.ok) resolve(message.dictionary);
      else reject(new Error(message.error));
    });
    worker.once("error", (error) => {
      done();
      reject(error);
    });
    worker.once("exit", (code) => {
      done();
      reject(new Error(`fault dictionary worker exited with code ${code}`));
    });
    worker.postMessage(request);
  });
}

/**
 * Background builder for fault dictionaries: one worker thread at a time (each dictionary is tens of seconds of CPU),
 * FIFO across revisions. Results are saved as the `faults.json` artifact and announced with a "faults.ready" timeline
 * event; failures are only logged. `idle()` resolves when the queue is empty (tests, seed script).
 */
export interface FaultQueue {
  enqueue(job: FaultJob): void;
  idle(): Promise<void>;
}

export function createFaultQueue(deps: { store: MissionStore; log?: BackgroundLog }): FaultQueue {
  const { store, log } = deps;
  let tail: Promise<void> = Promise.resolve();

  async function build(job: FaultJob): Promise<void> {
    const existing = await store.getRevision(job.missionId, job.n);
    if (!existing || existing.results.artifacts[FAULTS_ARTIFACT]) return; // revisions are immutable: build once
    const started = performance.now();
    const dictionary = await runWorker({ circuit: job.circuit, layout: job.layout, plan: job.plan, hex: job.benchHex, maxFaults: MAX_FAULTS });
    const ms = Math.round(performance.now() - started);
    const hash = await store.putArtifact(JSON.stringify(dictionary), "application/json");
    await store.saveResults(job.missionId, job.n, { artifacts: { [FAULTS_ARTIFACT]: hash } });
    await store.appendEvent({
      missionId: job.missionId,
      channel: "system",
      actor: SYSTEM_ACTOR,
      kind: "faults.ready",
      text: `Fault dictionary ready: ${dictionary.entries.length} simulated wiring mistakes for diagnosis.`,
      revision: job.n,
      data: { faults: dictionary.entries.map((e) => e.fault), ms },
    });
    log?.info({ missionId: job.missionId, revision: job.n, entries: dictionary.entries.length, ms }, "fault dictionary ready");
  }

  return {
    enqueue(job: FaultJob): void {
      tail = tail.then(() =>
        build(job).catch((error: unknown) => {
          log?.warn({ missionId: job.missionId, revision: job.n, err: errorMessage(error) }, "fault dictionary failed");
        }),
      );
    },
    idle(): Promise<void> {
      return tail;
    },
  };
}

/** Loads a revision's fault dictionary artifact, if it has been built. */
export async function loadFaultDictionary(store: MissionStore, artifacts: Record<string, string>): Promise<FaultDictionary | undefined> {
  const hash = artifacts[FAULTS_ARTIFACT];
  if (!hash) return undefined;
  const artifact = await store.getArtifact(hash);
  return artifact ? (JSON.parse(new TextDecoder().decode(artifact.data)) as FaultDictionary) : undefined;
}
