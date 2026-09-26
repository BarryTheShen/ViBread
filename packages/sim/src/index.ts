import type {
  Circuit,
  Coverage,
  PinModeObservation,
  Scenario,
  ScenarioResult,
  SimRunResult,
  TestSuite,
  Trace,
} from "@vibread/core";
import { observePinModesCore, runScenarioCore } from "./engine.js";
import { runSuiteWithWorkers } from "./pool.js";

export { SimSession } from "./browser.js";
export { coverageOf } from "./coverage.js";

export async function runScenario(input: { circuit: Circuit; hex: string; scenario: Scenario }): Promise<{ result: ScenarioResult; trace: Trace; pinModes: PinModeObservation[] }> {
  return runScenarioCore(input);
}

export async function runSuite(input: { circuit: Circuit; hex: string; suite: TestSuite; revisionHash: string; recordTraces?: boolean }): Promise<SimRunResult> {
  return runSuiteWithWorkers(input);
}

export async function observePinModes(input: { circuit: Circuit; hex: string; ms?: number }): Promise<PinModeObservation[]> {
  return Promise.resolve(observePinModesCore(input));
}


export type { Coverage };
