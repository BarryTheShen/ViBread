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

/** Only the independent test writer writes tests; a suite with coverage gaps is never reused, so proposing again re-asks it. */
const COVERAGE_RETRY = "Propose the same design again: that re-asks the independent test writer, and a suite with coverage gaps is never reused.";
function reportFor(input: { revisionHash: string; scenarios: SimRunResult["scenarios"]; coverage: Coverage; suite: TestSuite }): ConsoleReport {
  const findings: ConsoleReport["findings"] = [];
  const setAside = new Map(input.suite.scenarios.flatMap((scenario) => (scenario.setAside ? [[scenario.id, scenario.setAside] as const] : [])));
  for (const scenario of input.scenarios) {
    if (scenario.ok) continue;
    const detail = scenario.steps.filter((step) => !step.ok).map((step) => `${step.index + 1}. ${step.message}`).join("; ");
    const reason = setAside.get(scenario.id);
    findings.push(
      reason
        ? {
            console: "FIDO",
            ruleId: "TEST-SET-ASIDE",
            severity: "warning",
            title: `${scenario.id} set aside: the test review didn't confirm it matches the intent`,
            detail: `${reason} Failure: ${detail}`,
            fix: "Nothing to change in the design for this test. Mention it to the person if they care about what it checked.",
            refs: { scenarios: [scenario.id] },
          }
        : {
            console: "FIDO",
            ruleId: "SIM-FAIL",
            severity: "error",
            title: `${scenario.id}: ${scenario.title}`,
            detail,
            fix: "Review the failed scenario and check the design, sketch, and wiring together.",
            refs: { scenarios: [scenario.id] },
          },
    );
  }
  // Coverage gaps warn, except an intent clause with no test at all (then nothing checked it).
  for (const [part, asserted] of Object.entries(input.coverage.outputsAsserted)) {
    if (!asserted) findings.push({ console: "FIDO", ruleId: "COV-OUTPUT", severity: "warning", title: `${part} output is not asserted`, detail: `${part} never appears in an expect-part, expect-pwm, or expect-tone step.`, fix: `${COVERAGE_RETRY} Make sure an intent clause says what ${part} does.` });
  }
  for (const [part, exercised] of Object.entries(input.coverage.inputsExercised)) {
    if (!exercised) findings.push({ console: "FIDO", ruleId: "COV-INPUT", severity: "warning", title: `${part} input is not exercised`, detail: `${part} is present in the circuit but no scenario changes or presses it.`, fix: `${COVERAGE_RETRY} Make sure an intent clause says what using ${part} does.` });
  }
  for (const [clause, scenarios] of Object.entries(input.coverage.clausesCovered)) {
    if (scenarios.length === 0) findings.push({ console: "FIDO", ruleId: "COV-CLAUSE", severity: "error", title: `${clause} intent is not covered`, detail: "No scenario names this intent clause.", fix: `${COVERAGE_RETRY} If ${clause} isn't something a person can observe, reword it so it is.` });
  }
  for (const category of input.coverage.categoriesRequired) {
    if (!input.coverage.categoriesPresent.includes(category)) findings.push({ console: "FIDO", ruleId: "COV-CATEGORY", severity: "warning", title: `Missing ${category} scenario`, detail: `The suite should have a ${category} test for this circuit.`, fix: COVERAGE_RETRY });
  }
  const failed = input.scenarios.filter((scenario) => !scenario.ok && !setAside.has(scenario.id)).length;
  const asideFailed = input.scenarios.filter((scenario) => !scenario.ok && setAside.has(scenario.id)).length;
  // Set-aside tests still count for coverage (excluding them would send the agent back to the test writer in a loop),
  // but the summary names the clauses they leave without a live test.
  const unguarded = Object.entries(input.coverage.clausesCovered).flatMap(([clause, scenarios]) => (scenarios.length > 0 && scenarios.every((id) => setAside.has(id)) ? [clause] : []));
  const notes = [...(asideFailed ? [`${asideFailed} set-aside test${asideFailed === 1 ? "" : "s"} failed (warning only)`] : []), ...(unguarded.length ? [`no live test is left for ${unguarded.join(", ")}`] : [])];
  const asideNote = notes.length ? ` ${notes.join("; ")}.` : "";
  const blocking = findings.some((finding) => finding.severity === "error");
  const gaps = input.coverage.missing.length;
  const gapNote = gaps ? `; ${gaps} coverage gap${gaps === 1 ? "" : "s"} (warnings only)` : " and coverage is complete";
  const summary = !blocking
    ? `GO: ${input.scenarios.length - asideFailed} scenarios passed${gapNote}.${asideNote}`
    : `NO-GO: ${failed} scenario${failed === 1 ? "" : "s"} failed; ${gaps} coverage gap${gaps === 1 ? "" : "s"}.${asideNote}`;
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

/**
 * Idle simulation workers, kept between suites: starting one (the tsx loader, the engine and avr8js) costs about 350 ms,
 * which every evaluation paid on its compile → simulate critical path. Unref'd, so they never keep a process alive; a
 * worker that errors or exits is dropped, never reused.
 */
const idleWorkers: Worker[] = [];
const IDLE_LIMIT = 8;

function startWorker(): Worker {
  const sourceEntry = new URL("./worker-entry.ts", import.meta.url);
  const sourceMode = sourceEntry.pathname.endsWith(".ts");
  const entry = sourceMode ? new URL("./worker-loader.mjs", import.meta.url) : new URL("./worker-entry.js", import.meta.url);
  const options = sourceMode ? { execArgv: ["--import", import.meta.resolve("tsx/esm")] } : {};
  const worker = new Worker(entry, options);
  // An error while idle (nobody waiting for it) ends the worker; the exit handler drops it from the idle list.
  worker.on("error", () => undefined);
  worker.once("exit", () => {
    const index = idleWorkers.indexOf(worker);
    if (index >= 0) idleWorkers.splice(index, 1);
  });
  return worker;
}

async function runWorker(request: WorkerRequest): Promise<ScenarioExecution> {
  const worker = idleWorkers.pop() ?? startWorker();
  // Held while it runs a scenario; an idle worker never keeps the process alive.
  worker.ref();
  const { promise, resolve, reject } = Promise.withResolvers<ScenarioExecution>();
  const finish = (error?: Error, result?: ScenarioExecution) => {
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
    if (!error && result && idleWorkers.length < IDLE_LIMIT) {
      worker.unref();
      idleWorkers.push(worker);
    } else void worker.terminate();
    if (error) reject(error);
    else if (result) resolve(result);
    else reject(new Error("simulation worker returned no result"));
  };
  const onMessage = (message: ScenarioPayload) => finish(undefined, message.result);
  const onError = (error: Error) => finish(error);
  const onExit = (code: number) => finish(new Error(`simulation worker exited (code ${code})`));
  worker.once("message", onMessage);
  worker.once("error", onError);
  worker.once("exit", onExit);
  worker.postMessage(request);
  return promise;
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
    report: reportFor({ revisionHash: input.revisionHash, scenarios, coverage, suite: input.suite }),
    speed: virtualMs / wallMs,
  };
}
