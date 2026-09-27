import { parentPort } from "node:worker_threads";
import type { Circuit, Scenario } from "@vibread/core";
import { executeScenario } from "./engine.js";

interface WorkerRequest {
  circuit: Circuit;
  hex: string;
  scenario: Scenario;
}

if (!parentPort) throw new Error("simulation worker requires a parent port");
// One scenario per message; the pool keeps an idle worker for the next suite (pool.ts).
parentPort.on("message", (request: WorkerRequest) => {
  const result = executeScenario(request);
  parentPort?.postMessage({ result });
});
