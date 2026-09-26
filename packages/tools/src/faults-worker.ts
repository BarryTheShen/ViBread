import { buildFaultDictionary } from "@vibread/bench";
import type { Circuit, Layout, SelfTestPlan } from "@vibread/core";
import { parentPort } from "node:worker_threads";

/** Worker thread: the fault simulations are synchronous CPU work (seconds per mutant) that must not block the server. */
export interface FaultWorkerRequest {
  circuit: Circuit;
  layout: Layout;
  plan: SelfTestPlan;
  hex: string;
  maxFaults: number;
}

parentPort?.once("message", (request: FaultWorkerRequest) => {
  buildFaultDictionary(request).then(
    (dictionary) => parentPort?.postMessage({ ok: true, dictionary }),
    (error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }),
  );
});
