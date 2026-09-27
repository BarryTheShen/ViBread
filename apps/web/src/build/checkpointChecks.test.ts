import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BenchRunResult, Circuit, DeviceLine, RevisionDetail, SelfTestPlan, TestId } from "@vibread/core";
import { revisionHash } from "@vibread/core";
import { evaluateRun, LineDecoder, planSelfTest } from "@vibread/bench";
import { buildSteps, layoutBoard } from "@vibread/assembly";
import { compileBenchFirmware } from "@vibread/firmware";
import { GOLDEN } from "@vibread/fixtures";
import { SimSession } from "@vibread/sim/browser";
import { checkpointChecksForRevision, checkpointChecksPass, checkpointTests, describeCheckpointChecks, isFullSelfTestStep } from "./checkpointChecks.js";

/**
 * Issue 21: every run here is the real thing — the design's bench firmware on the simulator, answered the way the page
 * answers (Done, the LED seen, or "timeout" when the prompt runs out), judged by packages/bench's evaluateRun with the
 * test list the server judges a checkpoint run by. No hand-built results: the server never stores those shapes.
 */

const launch = GOLDEN.find((entry) => entry.key === "launch-control")!;
const circuit = launch.circuit;
const hash = revisionHash(circuit, launch.suite);
const plan = planSelfTest(circuit, hash);
const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
const subsection = steps.find((step) => step.title.startsWith("Subsection checkpoint"))!;
const finalPowerUp = steps.find((step) => isFullSelfTestStep(step))!;
let hex = "";

beforeAll(async () => {
  const compiled = await compileBenchFirmware(plan);
  if (!compiled.ok || compiled.hex === undefined) throw new Error(`bench firmware did not compile: ${compiled.log}`);
  hex = compiled.hex;
}, 120_000);

type Answer = (ask: Extract<DeviceLine, { t: "ask" }>, seen: string) => string;

/** What the virtual board's person does: Done for hands-on prompts, the LED actually lit, what was heard. */
const honest: Answer = (_ask, seen) => seen;

/** The runner in the browser: each listed test run on its own to its `end` line, prompts answered as `answer` says. */
function runOnBoard(tests: readonly TestId[], answer: Answer = honest): { lines: DeviceLine[]; answers: Record<string, string> } {
  const session = new SimSession({ circuit, hex });
  const decoder = new LineDecoder();
  const lines: DeviceLine[] = [];
  const answers: Record<string, string> = {};
  const asks: Array<Extract<DeviceLine, { t: "ask" }>> = [];
  session.onSerial((chunk) => {
    for (const line of decoder.push(chunk)) {
      if (line.t === "invalid") continue;
      lines.push(line);
      if (line.t === "ask") asks.push(line);
    }
  });
  const seenFor = (ask: Extract<DeviceLine, { t: "ask" }>): string => {
    if (ask.kind === "press-hold") session.setDigital(ask.part ?? "", true);
    if (ask.kind === "release") session.setDigital(ask.part ?? "", false);
    if (ask.kind === "which-led") {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        session.run(plan.timing.ledOnMs);
        const lit = plan.subjects.find((subject) => subject.kind === "led" && session.partState(subject.part) > 0.02);
        if (lit?.kind === "led") return String(lit.order);
      }
      return "none";
    }
    if (ask.kind === "heard-beep") {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        session.run(20);
        if (session.partState(ask.part ?? "") > 0) return "yes";
      }
      return "no";
    }
    return "done";
  };
  session.run(100);
  for (const test of ["rails.vcc", ...tests.filter((test) => test !== "rails.vcc")]) {
    const from = lines.length;
    session.serialWrite(`${JSON.stringify({ c: "run", test })}\n`);
    for (let slice = 0; slice < 400 && !lines.slice(from).some((line) => line.t === "end" && line.test === test); slice += 1) {
      session.run(50);
      for (const ask of asks.splice(0, asks.length)) {
        const value = answer(ask, seenFor(ask));
        answers[ask.id] = value;
        session.serialWrite(`${JSON.stringify({ c: "answer", id: ask.id, v: value })}\n`);
      }
    }
  }
  return { lines, answers };
}

/** POST /bench/runs: the server judges a checkpoint run by the requested tests its own plan has (routes.ts). */
async function serverEvaluates(tests: readonly TestId[], run: { lines: DeviceLine[]; answers: Record<string, string> }): Promise<BenchRunResult> {
  const requested = plan.tests.filter((test) => tests.includes(test));
  const judged: SelfTestPlan = requested.length > 0 && requested.length < plan.tests.length ? { ...plan, tests: requested } : plan;
  return evaluateRun({ circuit, layout: layoutBoard(circuit), plan: judged, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: `virtual-${Math.random()}` });
}

function checksFor(step: typeof subsection, runs: BenchRunResult[]) {
  return checkpointChecksForRevision({ circuit, revisionHash: hash, tests: step.checkpoint!.tests, plan, runs, fullSelfTest: isFullSelfTestStep(step), step: step.n });
}

describe("checkpoint checklist on real bench runs (issue 21)", () => {
  it("unlocks Done after the subsection checkpoint's own run passes, continuity checked by eye", async () => {
    const before = checksFor(subsection, []);
    expect(checkpointChecksPass(before)).toBe(false);
    const tests = checkpointTests(before);
    expect(tests).toEqual(["net.continuity", "button.interactive", "led.sequence", "buzzer.confirm"]);

    const result = await serverEvaluates(tests, runOnBoard(tests));
    expect(result.verdict).toBe("pass");
    expect(result.results.find((entry) => entry.test === "net.continuity")?.status).toBe("skipped");

    const checks = checksFor(subsection, [result]);
    const continuity = checks.filter((check) => check.test === "net.continuity");
    expect(continuity.length).toBeGreaterThan(1);
    expect(continuity.every((check) => check.status === "manual")).toBe(true);
    expect(checks.filter((check) => check.test !== "net.continuity").map((check) => [check.id, check.status])).toEqual([
      ["button.interactive:BTN1", "pass"],
      ["button.interactive:BTN2", "pass"],
      ["led.sequence:LED1", "pass"],
      ["led.sequence:LED2", "pass"],
      ["led.sequence:LED3", "pass"],
      ["buzzer.confirm:BZ1", "pass"],
    ]);
    expect(checkpointChecksPass(checks)).toBe(true);
  }, 60_000);

  it("keeps Done locked when a button prompt timed out, even after an earlier run passed", async () => {
    const tests = checkpointTests(checksFor(subsection, []));
    const earlier = await serverEvaluates(tests, runOnBoard(tests));
    const result = await serverEvaluates(tests, runOnBoard(tests, (ask, seen) => (ask.id === "btn0-press" ? "timeout" : seen)));
    expect(result.verdict).toBe("incomplete");
    // The latest run of a test answers for it: an unfinished rerun doesn't let the older pass stand.
    const checks = checksFor(subsection, [earlier, result]);
    expect(checks.find((check) => check.id === "button.interactive:BTN1")?.status).toBe("incomplete");
    expect(checkpointChecksPass(checks)).toBe(false);
  }, 60_000);

  it("names the problem and keeps Done locked when the wrong LED is picked", async () => {
    const tests = checkpointTests(checksFor(subsection, []));
    const result = await serverEvaluates(tests, runOnBoard(tests, (ask, seen) => (ask.id === "led2" ? "3" : seen)));
    expect(result.verdict).toBe("fail");
    const checks = checksFor(subsection, [result]);
    const led2 = checks.find((check) => check.id === "led.sequence:LED2");
    expect(led2?.status).toBe("fail");
    expect(led2?.diagnosis).toBe(result.diagnosis.summary);
    expect(led2?.diagnosis?.length).toBeGreaterThan(0);
    expect(checkpointChecksPass(checks)).toBe(false);
  }, 60_000);

  it("runs exactly the displayed full self-test at Final power-up and unlocks Done", async () => {
    const before = checksFor(finalPowerUp, []);
    // The checklist shows the whole plan; "Run these checks" must ask for exactly that, not the step's two tests.
    expect(finalPowerUp.checkpoint?.tests).toEqual(["rails.vcc", "pins.readonly"]);
    expect(checkpointTests(before)).toEqual(plan.tests);

    const result = await serverEvaluates(checkpointTests(before), runOnBoard(checkpointTests(before)));
    expect(result.verdict).toBe("pass");
    expect(checkpointChecksPass(checksFor(finalPowerUp, [result]))).toBe(true);
    // The step's own two tests plus an earlier subsection pass cover every row piecemeal, but that isn't a full run.
    const partial = await serverEvaluates(finalPowerUp.checkpoint!.tests, runOnBoard(finalPowerUp.checkpoint!.tests));
    const subsectionTests = checkpointTests(checksFor(subsection, []));
    const earlierSubsection = await serverEvaluates(subsectionTests, runOnBoard(subsectionTests));
    expect(partial.verdict).toBe("pass");
    expect(earlierSubsection.verdict).toBe("pass");
    expect(checkpointChecksPass(checksFor(finalPowerUp, [partial]))).toBe(false);
    expect(checkpointChecksPass(checksFor(finalPowerUp, [earlierSubsection, partial]))).toBe(false);
    expect(checkpointChecksPass(checksFor(finalPowerUp, [earlierSubsection, partial, result]))).toBe(true);
  }, 90_000);

  it("unlocks the phone within a poll of the laptop's run landing on the revision", async () => {
    const tests = checkpointTests(checksFor(subsection, []));
    const passed = await serverEvaluates(tests, runOnBoard(tests));
    // Imported here, not at the top: Query Core only runs its timers when it sees these browser globals at import time.
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "visible" });
    try {
      const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
      const { revisionQueryOptions } = await import("./api.js");
      const revision = { n: 1, hash, circuit, results: { selftest: plan, bench: [] as BenchRunResult[] } } as unknown as RevisionDetail;
      let serverView = revision;
      const client = new QueryClient();
      // The phone's real query options while the checkpoint step waits, with only the network call replaced.
      const observer = new QueryObserver(client, { ...revisionQueryOptions("m1", 1, true), queryFn: async () => serverView });
      let phoneDone = false;
      const unsubscribe = observer.subscribe((state) => {
        if (state.data) phoneDone = checkpointChecksPass(checkpointChecksForRevision({ circuit, revisionHash: hash, tests: subsection.checkpoint!.tests, plan, runs: state.data.results.bench, fullSelfTest: false }));
      });
      await observer.refetch();
      expect(phoneDone).toBe(false);
      serverView = { ...revision, results: { ...revision.results, bench: [passed] } } as RevisionDetail; // the laptop's POST /bench/runs
      await vi.waitFor(() => expect(phoneDone).toBe(true), { timeout: 2_500, interval: 25 });
      unsubscribe();
      client.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it("doesn't let the bare-board check's run tick the later power checkpoint that asks for the same test", async () => {
    const [bareBoard, powerCheckpoint] = steps.filter((step) => step.checkpoint?.tests.join() === "rails.vcc");
    expect(bareBoard.n).toBeLessThan(powerCheckpoint.n);
    // The server stores the step the run was launched from (POST /bench/runs `step`).
    const fromBareBoard: BenchRunResult = { ...(await serverEvaluates(["rails.vcc"], runOnBoard(["rails.vcc"]))), step: bareBoard.n };
    expect(fromBareBoard.verdict).toBe("pass");
    expect(checkpointChecksPass(checksFor(bareBoard, [fromBareBoard]))).toBe(true);
    expect(checkpointChecksPass(checksFor(powerCheckpoint, [fromBareBoard]))).toBe(false);
    // A run not launched from any step (older runs, a full self-test from the bench page) still counts everywhere.
    const unscoped: BenchRunResult = { ...fromBareBoard, step: undefined };
    expect(checkpointChecksPass(checksFor(powerCheckpoint, [unscoped]))).toBe(true);
  }, 60_000);
});

describe("checkpoint checklist wording", () => {
  it("derives concrete subject expectations from the self-test plan", () => {
    const checks = describeCheckpointChecks({ tests: ["led.sequence", "button.interactive"], plan });
    expect(checks.map((check) => check.expected)).toEqual([
      "Armed light (red) on D4 blinks when asked",
      "Countdown light (yellow) on D5 blinks when asked",
      "Liftoff light (green) on D6 blinks when asked",
      "ARM button on D2 reads LOW when pressed",
      "LAUNCH button on D3 reads LOW when pressed",
    ]);
  });

  it("uses the USB VCC wording for the board-power check", () => {
    expect(describeCheckpointChecks({ tests: ["rails.vcc"] })[0]?.expected).toBe("Board powered (USB VCC ≈ 5 V)");
  });

  it("splits continuity into one row per net and only collapses consecutive LEDs into a range", () => {
    const board = {
      parts: [1, 2, 3, 4, 5].map((n) => ({ id: `LED${n}`, module: "led", params: {} })).concat([{ id: "BTN1", module: "button", params: {} }]),
      nets: [
        { id: "GND", kind: "ground", pins: [{ part: "board", pin: "GND" }, ...[1, 2, 4, 5].map((n) => ({ part: `LED${n}`, pin: "K" })), { part: "BTN1", pin: "3" }] },
        { id: "D3", kind: "signal", pins: [{ part: "board", pin: "D3" }, { part: "LED3", pin: "A" }] },
      ],
    } as unknown as Circuit;
    expect(describeCheckpointChecks({ tests: ["net.continuity"], circuit: board }).map((check) => check.expected)).toEqual([
      "GND ↔ LED1–LED2 short legs, LED4–LED5 short legs, BTN1 leg 3 — connected",
      "D3 ↔ LED3 long leg — connected",
    ]);
  });

  it("lists only the step's own tests at Final power-up until the design's plan has loaded (phone first paint)", () => {
    const withoutPlan = describeCheckpointChecks({ tests: finalPowerUp.checkpoint!.tests, fullSelfTest: true });
    expect(withoutPlan.map((check) => check.test)).toEqual(["rails.vcc", "pins.readonly"]);
    // Launch Control has no knob or light sensor: no rows for them, even with the plan.
    expect(describeCheckpointChecks({ tests: finalPowerUp.checkpoint!.tests, fullSelfTest: true, plan }).map((check) => check.test)).not.toContain("pot.sweep");
  });
});

