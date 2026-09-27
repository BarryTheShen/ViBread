import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { layoutBoard } from "@vibread/assembly";
import { compileBenchFirmware } from "@vibread/firmware";
import { SimSession } from "@vibread/sim/browser";
import { revisionHash, type Circuit, type DecodedLine, type DeviceLine, type SelfTestPlan } from "@vibread/core";
import { applyFault, calibrationMacros, LineDecoder, evaluateRun, planSelfTest } from "./index.js";

const moon = GOLDEN.find((entry) => entry.key === "moon-phase-lamp");
const knob = GOLDEN.find((entry) => entry.key === "knob-night-light");
const launch = GOLDEN.find((entry) => entry.key === "launch-control");
if (moon === undefined || knob === undefined || launch === undefined) throw new Error("golden moon, knob, and launch fixtures are required");

interface VirtualRun {
  lines: DeviceLine[];
  invalid: DecodedLine[];
  answers: Record<string, string>;
}




function answerForAsk(session: SimSession, plan: SelfTestPlan, ask: Extract<DeviceLine, { t: "ask" }>, answered: Set<string>, answers: Record<string, string>): void {
  if (answered.has(ask.id)) return;
  if (ask.id.endsWith("-press")) session.setDigital(ask.part ?? "BTN1", true);
  if (ask.id.endsWith("-release")) session.setDigital(ask.part ?? "BTN1", false);
  if (ask.id.endsWith("-cover")) session.setLight(ask.part ?? "LDR1", 0.05);
  if (ask.id.endsWith("-uncover")) session.setLight(ask.part ?? "LDR1", 0.8);
  if (ask.id.startsWith("pot") && ask.id.endsWith("-min")) session.setAnalog(ask.part ?? "POT1", 0);
  if (ask.id.startsWith("pot") && ask.id.endsWith("-max")) session.setAnalog(ask.part ?? "POT1", 1);

  let value = "done";
  if (ask.kind === "which-led") {
    // Advance in short slices outside the serial callback so at least one pulse
    // enters the rolling partState window without re-entering SimSession.run.
    const ledSubjects = plan.subjects.filter((subject): subject is Extract<typeof plan.subjects[number], { kind: "led" }> => subject.kind === "led");
    let brightest = ledSubjects[0];
    let brightness = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      session.run(plan.timing.ledOnMs);
      for (const subject of ledSubjects) {
        const value = session.partState(subject.part);
        if (value > brightness) {
          brightness = value;
          brightest = subject;
        }
      }
      if (brightness > 0.02) break;
    }
    value = brightest === undefined || brightness <= 0.02 ? "none" : String(brightest.order);
  } else if (ask.kind === "heard-beep") {
    let heard = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      session.run(20);
      if (session.partState(ask.part ?? "BZ1") > 0) {
        heard = true;
        break;
      }
    }
    value = heard ? "yes" : "no";
  }
  answers[ask.id] = value;
  session.serialWrite(`${JSON.stringify({ c: "answer", id: ask.id, v: value })}\n`);
  answered.add(ask.id);
}

/** Run `run all`, or each listed test on its own to its `end` line (a Build Steps checkpoint), answering every prompt at once. */
function runVirtual(circuit: Circuit, plan: SelfTestPlan, hex: string, tests: readonly string[] = ["all"]): VirtualRun {
  const session = new SimSession({ circuit, hex, light: { LDR1: 0.8 } });
  const decoder = new LineDecoder();
  const lines: DeviceLine[] = [];
  const invalid: DecodedLine[] = [];
  const answered = new Set<string>();
  const answers: Record<string, string> = {};
  const pendingAsks: Array<Extract<DeviceLine, { t: "ask" }>> = [];
  let finished: (line: DeviceLine) => boolean = () => false;
  let done = false;
  session.onSerial((chunk) => {
    for (const decoded of decoder.push(chunk)) {
      if (decoded.t === "invalid") invalid.push(decoded);
      else {
        lines.push(decoded);
        if (decoded.t === "ask") pendingAsks.push(decoded);
        if (finished(decoded)) done = true;
      }
    }
  });
  const answerPending = (): void => {
    while (pendingAsks.length > 0) {
      const ask = pendingAsks.shift();
      if (ask !== undefined) answerForAsk(session, plan, ask, answered, answers);
    }
  };
  session.run(100);
  for (const test of tests) {
    done = false;
    finished = (line) => (test === "all" ? line.t === "done" : line.t === "end" && line.test === test);
    session.serialWrite(`${JSON.stringify({ c: "run", test })}\n`);
    for (let slice = 0; slice < 200 && !done; slice += 1) {
      session.run(50);
      answerPending();
    }
    if (!done) throw new Error(`virtual bench did not finish ${test} within its bounded run window`);
  }
  return { lines, invalid, answers };
}

describe("virtual bench protocol", () => {
  it("runs golden and three physical layout faults through firmware, simulator, and evaluator", async () => {
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const compiled = await compileBenchFirmware(plan);
    expect(compiled.ok, compiled.log).toBe(true);
    if (!compiled.ok || compiled.hex === undefined) throw new Error("bench firmware did not compile");

    const goodLayout = layoutBoard(moon.circuit);
    const goodLines = runVirtual(moon.circuit, plan, compiled.hex);
    expect(goodLines.invalid, JSON.stringify(goodLines.invalid)).toHaveLength(0);
    expect(goodLines.lines.some((line) => line.t === "done")).toBe(true);
    const good = await evaluateRun({ circuit: moon.circuit, layout: goodLayout, plan, lines: goodLines.lines, answers: goodLines.answers, kind: "selftest", revision: 1, runId: "virtual-good" });
    expect(good.verdict, JSON.stringify(good.results)).toBe("pass");
    expect(calibrationMacros(good.calibration)).toMatchObject({ VB_CAL_LDR1_DARK: expect.any(Number), VB_CAL_LDR1_HYST: expect.any(Number) });

    const faultSpecs = [
      { name: "button", fault: "button-leg-in-gnd-row" as const },
      { name: "leds", fault: "led-jumpers-swapped" as const },
      { name: "divider", fault: "divider-resistor-missing" as const },
    ];
    const faults = faultSpecs.map((spec) => ({ ...spec, ...applyFault({ circuit: moon.circuit, layout: goodLayout, fault: spec.fault }) }));
    for (const fault of faults) {
      const run = runVirtual(fault.circuit, plan, compiled.hex);
      expect(run.invalid, `${fault.name}: ${JSON.stringify(run.invalid)}`).toHaveLength(0);
      const result = await evaluateRun({ circuit: moon.circuit, layout: goodLayout, plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: `virtual-${fault.name}` });
      expect(result.verdict, fault.name).toBe("fail");
      expect(result.diagnosis.candidates.slice(0, 2).map((candidate) => candidate.cause), `${fault.name}: ${JSON.stringify({ diagnosis: result.diagnosis, results: result.results })}`).toContain(fault.fault);
      expect(result.diagnosis.candidates[0]?.highlight.holes.length, fault.name).toBeGreaterThan(0);
    }
  }, 120_000);
  it("handles a moon IR whose light role precedes the LED roles", async () => {
    const reordered = structuredClone(moon.circuit);
    reordered.roles = [...reordered.roles].sort((left, right) => (left.part === "LDR1" ? -1 : right.part === "LDR1" ? 1 : 0));
    const plan = planSelfTest(reordered, revisionHash(reordered));
    const compiled = await compileBenchFirmware(plan);
    expect(compiled.ok, compiled.log).toBe(true);
    if (!compiled.ok || compiled.hex === undefined) throw new Error("reordered moon bench firmware did not compile");
    const layout = layoutBoard(reordered);
    const run = runVirtual(reordered, plan, compiled.hex);
    expect(run.invalid, JSON.stringify(run.invalid)).toHaveLength(0);
    const result = await evaluateRun({ circuit: reordered, layout, plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: "virtual-reordered-moon" });
    expect(result.verdict, JSON.stringify(result.results)).toBe("pass");
  }, 120_000);
  it("runs the Knob Night-Light golden through the same virtual bench script", async () => {
    const plan = planSelfTest(knob.circuit, revisionHash(knob.circuit));
    const compiled = await compileBenchFirmware(plan);
    expect(compiled.ok, compiled.log).toBe(true);
    if (!compiled.ok || compiled.hex === undefined) throw new Error("knob bench firmware did not compile");
    const layout = layoutBoard(knob.circuit);
    const run = runVirtual(knob.circuit, plan, compiled.hex);
    expect(run.invalid, JSON.stringify(run.invalid)).toHaveLength(0);
    const result = await evaluateRun({ circuit: knob.circuit, layout, plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: "virtual-knob" });
    expect(result.verdict, JSON.stringify(result.results)).toBe("pass");
  }, 120_000);
  it("runs Launch Control and answers the buzzer heard-beep prompt from simulated sound", async () => {
    const plan = planSelfTest(launch.circuit, revisionHash(launch.circuit));
    const compiled = await compileBenchFirmware(plan);
    expect(compiled.ok, compiled.log).toBe(true);
    if (!compiled.ok || compiled.hex === undefined) throw new Error("launch bench firmware did not compile");
    const layout = layoutBoard(launch.circuit);
    const run = runVirtual(launch.circuit, plan, compiled.hex);
    expect(run.invalid, JSON.stringify(run.invalid)).toHaveLength(0);
    expect(run.answers.buzzer0).toBe("yes");
    const result = await evaluateRun({ circuit: launch.circuit, layout, plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: "virtual-launch" });
    expect(result.verdict, JSON.stringify(result.results)).toBe("pass");
    expect(result.results.find((entry) => entry.test === "buzzer.confirm")?.status).toBe("pass");
  }, 120_000);
  it("passes Launch Control's checkpoint subset, buttons included, when each prompt is answered at once", async () => {
    const plan = planSelfTest(launch.circuit, revisionHash(launch.circuit));
    const compiled = await compileBenchFirmware(plan);
    if (!compiled.ok || compiled.hex === undefined) throw new Error(`launch bench firmware did not compile: ${compiled.log}`);
    // The Build Steps deep link runs these one at a time (?tests=net.continuity,button.interactive,led.sequence).
    const tests = ["net.continuity", "button.interactive", "led.sequence"] as const;
    const run = runVirtual(launch.circuit, plan, compiled.hex, tests);
    expect(run.invalid, JSON.stringify(run.invalid)).toHaveLength(0);
    const ends = Object.fromEntries(run.lines.flatMap((line) => (line.t === "end" ? [[line.test, line.status]] : [])));
    expect(ends).toMatchObject({ "button.interactive": "pass", "led.sequence": "pass" });
    const result = await evaluateRun({ circuit: launch.circuit, layout: layoutBoard(launch.circuit), plan: { ...plan, tests: [...tests] }, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: "virtual-launch-subset" });
    expect(result.results.find((entry) => entry.test === "button.interactive")?.status, JSON.stringify(result.results)).toBe("pass");
  }, 120_000);
});
