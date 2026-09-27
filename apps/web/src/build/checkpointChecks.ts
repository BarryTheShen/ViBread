import type { BenchRunResult, Circuit, SelfTestPlan, SelfTestSubject, TestId } from "@vibread/core";
import { planSelfTest } from "@vibread/bench";

/** The Final power-up step runs the whole self-test plan, not just the step's own tests. */
export function isFullSelfTestStep(step: { title: string; checkpoint?: { text: string } }): boolean {
  return /full(?:\s+staged)?\s+self-test/i.test(`${step.title} ${step.checkpoint?.text ?? ""}`);
}

/** `manual`: the board can't measure it (skipped), so it's checked by eye. `incomplete`: the test ran but didn't finish. */
export type CheckpointCheckStatus = "pass" | "fail" | "manual" | "incomplete" | "not-run";

export interface CheckpointCheck {
  id: string;
  test: TestId;
  subject?: string;
  expected: string;
  status: CheckpointCheckStatus;
  diagnosis?: string;
}

function endpointLabel(circuit: Circuit, part: string, pin: string): string {
  if (part === "board") return `Arduino ${pin}`;
  const found = circuit.parts.find((candidate) => candidate.id === part);
  return found?.label ? `${found.label} (${part}) ${pin}` : `${part} ${pin}`;
}

function netName(net: Circuit["nets"][number]): string {
  const boardPin = net.pins.find((pin) => pin.part === "board")?.pin;
  if (boardPin === "5V" || net.kind === "power") return "5V";
  if (boardPin === "GND" || net.kind === "ground") return "GND";
  return boardPin ?? net.id;
}

function memberLabel(circuit: Circuit, partId: string, pin: string): string {
  const part = circuit.parts.find((candidate) => candidate.id === partId);
  if (part?.module === "led") return `${part.id} ${pin === "A" ? "long leg" : pin === "K" ? "short leg" : pin}`;
  if (part?.module === "resistor" || part?.module === "photoresistor") return `${part.id} either end`;
  if (part?.module === "button") return `${part.id} leg ${pin}`;
  return endpointLabel(circuit, partId, pin);
}

/** LED legs on one net, with consecutive LEDs collapsed ("LED1–LED3 short legs, LED5 short leg"). */
function compactLedMembers(labels: string[]): string[] {
  const rest = labels.filter((label) => !/^LED\d+ (?:short|long) leg$/.test(label));
  const grouped: string[] = [];
  for (const leg of ["short", "long"] as const) {
    const ids = labels
      .flatMap((label) => {
        const match = new RegExp(`^LED(\\d+) ${leg} leg$`).exec(label);
        return match ? [Number(match[1])] : [];
      })
      .sort((a, b) => a - b);
    for (let start = 0; start < ids.length; ) {
      let end = start;
      while (end + 1 < ids.length && ids[end + 1] === ids[end] + 1) end += 1;
      grouped.push(end > start ? `LED${ids[start]}–LED${ids[end]} ${leg} legs` : `LED${ids[start]} ${leg} leg`);
      start = end + 1;
    }
  }
  return [...grouped, ...rest];
}

function subjectExpected(subject: SelfTestSubject): string {
  switch (subject.kind) {
    case "led":
      return `${subject.label} on ${subject.pin} blinks when asked`;
    case "button":
      return `${subject.label} on ${subject.pin} reads ${subject.pressedLevel === 0 ? "LOW" : "HIGH"} when pressed`;
    case "light":
      return `${subject.label} on ${subject.pin} changes when covered`;
    case "pot":
      return `${subject.label} on ${subject.pin} sweeps from low to high`;
    case "buzzer":
      return `${subject.label} on ${subject.pin} is heard when asked`;
    case "digital-in":
      return `${subject.label} on ${subject.pin} reads a stable digital level`;
    case "analog-in":
      return `${subject.label} on ${subject.pin} reports a changing analog value`;
  }
}

function testExpected(test: TestId, circuit?: Circuit): string {
  switch (test) {
    case "rails.vcc":
      return "Board powered (USB VCC ≈ 5 V)";
    case "pins.readonly":
      return "All planned pins pass the read-before-drive safety check";
    case "net.continuity":
      return "Every listed net has continuity";
    case "button.interactive":
      return "Each button reads its expected level when pressed and released";
    case "light.relative":
      return "The light sensor changes when covered and uncovered";
    case "pot.sweep":
      return "The potentiometer sweeps from low to high";
    case "led.sequence":
      return "Each LED blinks in the expected sequence";
    case "buzzer.confirm":
      return "The buzzer is heard when asked";
    default:
      return `${test} passes`;
  }
}

/**
 * Each check reads the latest run that reported its test. A checkpoint run carries only its own tests, so an older full
 * run still answers for the tests it covered, and a later run of the same test replaces it (a new fail replaces a pass).
 */
function statusFor(test: TestId, subject: string | undefined, runs: BenchRunResult[]): { status: CheckpointCheckStatus; diagnosis?: string } {
  for (const run of [...runs].reverse()) {
    const result = run.results.find((candidate) => candidate.test === test);
    if (!result) continue;
    const subjectResult = subject === undefined ? undefined : result.subjects.find((candidate) => candidate.part === subject);
    const status = subjectResult?.status ?? result.status;
    return {
      status: status === "pass" ? "pass" : status === "fail" ? "fail" : status === "skipped" ? "manual" : "incomplete",
      diagnosis: status === "fail" ? run.diagnosis.summary : undefined,
    };
  }
  return { status: "not-run" };
}
function continuityChecks(circuit: Circuit, runs: BenchRunResult[]): CheckpointCheck[] {
  const base = statusFor("net.continuity", undefined, runs);
  return circuit.nets.map((net) => {
    const name = netName(net);
    const members = compactLedMembers(net.pins.filter((pin) => pin.part !== "board").map((pin) => memberLabel(circuit, pin.part, pin.pin)));
    const expected = members.length > 0 ? `${name} ↔ ${members.join(", ")} — connected` : `${name} — connected`;
    return {
      id: `net.continuity:${net.id}`,
      test: "net.continuity" as const,
      subject: net.id,
      expected,
      status: base.status,
      diagnosis: base.status === "fail" ? `${base.diagnosis ?? "Continuity failed."} Inspect ${name}.` : base.diagnosis,
    };
  });
}

export function describeCheckpointChecks(input: {
  tests: TestId[];
  circuit?: Circuit;
  plan?: SelfTestPlan;
  runs?: BenchRunResult[];
  fullSelfTest?: boolean;
  /** The build step showing this checklist: a run launched from a different step's checkpoint doesn't count here. */
  step?: number;
}): CheckpointCheck[] {
  const checks: CheckpointCheck[] = [];
  // Only the plan knows which parts this design has: until it arrives, a full-self-test step lists its own tests.
  const tests = input.fullSelfTest && input.plan ? input.plan.tests : input.tests;
  // Two steps can ask for the same tests (the bare-board check and the power checkpoint both run rails.vcc): a run from
  // one must not tick the other. Runs not started from a step (a full self-test, older runs) count everywhere.
  const ownRuns = (input.runs ?? []).filter((run) => run.step === undefined || run.step === input.step);
  // The Final power-up proves the finished board in one go: only a run that covered every listed test counts, so passes
  // collected piecemeal from earlier checkpoints (or from before the board was built) can't stand in for it.
  const runs = input.fullSelfTest ? ownRuns.filter((run) => tests.every((test) => run.results.some((result) => result.test === test))) : ownRuns;
  for (const test of tests) {
    if (test === "net.continuity" && input.circuit) {
      checks.push(...continuityChecks(input.circuit, runs));
      continue;
    }
    const subjects = input.plan?.subjects.filter((subject) => {
      if (test === "button.interactive") return subject.kind === "button";
      if (test === "light.relative") return subject.kind === "light";
      if (test === "pot.sweep") return subject.kind === "pot";
      if (test === "led.sequence") return subject.kind === "led";
      if (test === "buzzer.confirm") return subject.kind === "buzzer";
      return false;
    }) ?? [];
    if (subjects.length > 0) {
      for (const subject of subjects) {
        const result = statusFor(test, subject.part, runs);
        checks.push({ id: `${test}:${subject.part}`, test, subject: subject.part, expected: subjectExpected(subject), ...result });
      }
      continue;
    }
    const result = statusFor(test, undefined, runs);
    checks.push({
      id: `${test}:all`,
      test,
      expected: testExpected(test, input.circuit),
      ...result,
    });
  }
  return checks;
}

export function checkpointChecksForRevision(input: {
  circuit: Circuit;
  revisionHash: string;
  tests: TestId[];
  plan?: SelfTestPlan;
  runs?: BenchRunResult[];
  fullSelfTest?: boolean;
  step?: number;
}): CheckpointCheck[] {
  return describeCheckpointChecks({
    ...input,
    plan: input.plan ?? planSelfTest(input.circuit, input.revisionHash),
  });
}

/** The tests a checklist shows, in order: exactly what "Run these checks" asks the bench for. */
export function checkpointTests(checks: CheckpointCheck[]): TestId[] {
  return [...new Set(checks.map((check) => check.test))];
}

/**
 * Done is allowed when every check the board can measure passed in the latest run that reported it. Check-by-eye rows
 * never block it; they only appear once a run has reported them, so a checkpoint made only of them passes after that run.
 */
export function checkpointChecksPass(checks: CheckpointCheck[]): boolean {
  const measurable = checks.filter((check) => check.status !== "manual");
  if (measurable.length === 0) return checks.length > 0;
  return measurable.every((check) => check.status === "pass");
}

/** What a checkpoint row says about its status (web build steps and phone Build Mode). */
export function checkpointStatusText(status: CheckpointCheckStatus): string {
  switch (status) {
    case "pass":
      return "Pass";
    case "fail":
      return "Failed";
    case "manual":
      return "Check by eye — the board can't measure this connection; compare it with the picture";
    case "incomplete":
      return "Didn't finish — run the checks again";
    case "not-run":
      return "Not run yet";
  }
}
