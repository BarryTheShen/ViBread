import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Circuit, ConsoleReport, Coverage, PinModeObservation, SimRunResult, TestSuite, Trace } from "@vibread/core";
import { coverageOf } from "./coverage.js";
import { executeScenario, type ScenarioExecution } from "./engine.js";

interface ScenarioPayload {
  index: number;
  result: ScenarioExecution;
}

interface WorkerRequest {
  circuit: Circuit;
  hex: string;
  scenario: TestSuite["scenarios"][number];
}

function reportFor(input: { revisionHash: string; scenarios: SimRunResult["scenarios"]; coverage: Coverage }): ConsoleReport {
  const findings: ConsoleReport["findings"] = [];
  for (const scenario of input.scenarios) {
    if (!scenario.ok) {
      findings.push({
        console: "FIDO",
        ruleId: "SIM-FAIL",
        severity: "error",
        title: `${scenario.id}: ${scenario.title}`,
        detail: scenario.steps.filter((step) => !step.ok).map((step) => `${step.index + 1}. ${step.message}`).join("; "),
        fix: "Review the failed scenario and check the design, sketch, and wiring together.",
        refs: { scenarios: [scenario.id] },
      });
    }
  }
  for (const [part, asserted] of Object.entries(input.coverage.outputsAsserted)) {
    if (!asserted) findings.push({ console: "FIDO", ruleId: "COV-OUTPUT", severity: "error", title: `${part} output is not asserted`, detail: `${part} never appears in an expect-part, expect-pwm, or expect-tone step.`, fix: "Add an independent scenario assertion for this output." });
  }
  for (const [part, exercised] of Object.entries(input.coverage.inputsExercised)) {
    if (!exercised) findings.push({ console: "FIDO", ruleId: "COV-INPUT", severity: "error", title: `${part} input is not exercised`, detail: `${part} is present in the circuit but no scenario changes or presses it.`, fix: "Add a scenario that drives this input." });
  }
  for (const [clause, scenarios] of Object.entries(input.coverage.clausesCovered)) {
    if (scenarios.length === 0) findings.push({ console: "FIDO", ruleId: "COV-CLAUSE", severity: "error", title: `${clause} intent is not covered`, detail: "No scenario names this intent clause.", fix: "Add the clause to an independent scenario." });
  }
  for (const category of input.coverage.categoriesRequired) {
    if (!input.coverage.categoriesPresent.includes(category)) findings.push({ console: "FIDO", ruleId: "COV-CATEGORY", severity: "error", title: `Missing ${category} scenario`, detail: `The suite requires a ${category} test for this circuit.`, fix: `Add a scenario tagged ${category}.` });
  }
  const failed = input.scenarios.filter((scenario) => !scenario.ok).length;
  const summary = failed === 0 && input.coverage.ok ? `GO: ${input.scenarios.length} scenarios passed and coverage is complete.` : `NO-GO: ${failed} scenario${failed === 1 ? "" : "s"} failed; ${input.coverage.missing.length} coverage gap${input.coverage.missing.length === 1 ? "" : "s"}.`;
  return {
    console: "FIDO",
    verdict: findings.some((finding) => finding.severity === "error") ? "NO-GO" : "GO",
    summary,
    findings,
    evidence: { scenarios: input.scenarios.length, passed: input.scenarios.length - failed, coverageMissing: input.coverage.missing.length },
    revisionHash: input.revisionHash,
    at: new Date().toISOString(),
  };
}

function runLocally(input: { circuit: Circuit; hex: string; suite: TestSuite }): ScenarioExecution[] {
  return input.suite.scenarios.map((scenario) => executeScenario({ circuit: input.circuit, hex: input.hex, scenario }));
}

async function runWorker(request: WorkerRequest): Promise<ScenarioExecution> {
  return new Promise((resolve, reject) => {
    const sourceEntry = new URL("./worker-entry.ts", import.meta.url);
    const sourceMode = sourceEntry.pathname.endsWith(".ts");
    const entry = sourceMode ? new URL("./worker-loader.mjs", import.meta.url) : new URL("./worker-entry.js", import.meta.url);
    const options = sourceMode ? { execArgv: ["--import", import.meta.resolve("tsx/esm")] } : {};
    const worker = new Worker(entry, options);
    const finish = (error?: Error, result?: ScenarioExecution) => {
      void worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("simulation worker returned no result"));
    };
    worker.once("message", (message: ScenarioPayload) => finish(undefined, message.result));
    worker.once("error", (error: Error) => finish(error));
    worker.postMessage(request);
  });
}

async function runPool(input: { circuit: Circuit; hex: string; suite: TestSuite }): Promise<ScenarioExecution[]> {
  const count = Math.min(input.suite.scenarios.length, Math.max(1, Math.min(8, availableParallelism() - 2)));
  const results: Array<ScenarioExecution | undefined> = new Array(input.suite.scenarios.length);
  let cursor = 0;
  const workerTask = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= input.suite.scenarios.length) return;
      results[index] = await runWorker({ circuit: input.circuit, hex: input.hex, scenario: input.suite.scenarios[index] });
    }
  };
  await Promise.all(Array.from({ length: count }, () => workerTask()));
  return results.map((result) => result as ScenarioExecution);
}

export async function runSuiteWithWorkers(input: { circuit: Circuit; hex: string; suite: TestSuite; revisionHash: string; recordTraces?: boolean }): Promise<SimRunResult> {
  const started = performance.now();
  let outputs: ScenarioExecution[];
  try {
    outputs = await runPool(input);
  } catch {
    outputs = runLocally(input);
  }
  const scenarios = outputs.map((output) => output.result);
  const traces: Trace[] = input.recordTraces === false ? [] : outputs.map((output) => output.trace);
  const coverage = coverageOf(input.circuit, input.suite);
  const pinModesByPin = new Map<string, PinModeObservation>();
  for (const output of outputs) for (const observation of output.pinModes) {
    const previous = pinModesByPin.get(observation.pin);
    const mode = previous?.mode === "PWM_OUT" || observation.mode === "PWM_OUT" ? "PWM_OUT" : observation.mode;
    pinModesByPin.set(observation.pin, {
      pin: observation.pin,
      mode,
      toggled: Boolean(previous?.toggled || observation.toggled),
      ...(previous?.firstMs === undefined ? (observation.firstMs === undefined ? {} : { firstMs: observation.firstMs }) : { firstMs: previous.firstMs }),
    });
  }
  const virtualMs = scenarios.reduce((total, scenario) => total + scenario.durationMs, 0);
  const wallMs = Math.max(0.1, performance.now() - started);
  return {
    scenarios,
    coverage,
    pinModes: [...pinModesByPin.values()].sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true })),
    traces,
    report: reportFor({ revisionHash: input.revisionHash, scenarios, coverage }),
    speed: virtualMs / wallMs,
  };
}
