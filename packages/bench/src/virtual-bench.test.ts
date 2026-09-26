import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { asBuiltCircuit, layoutBoard } from "@vibread/assembly";
import { compileBenchFirmware } from "@vibread/firmware";
import { SimSession } from "@vibread/sim/browser";
import { revisionHash, type Circuit, type DecodedLine, type DeviceLine, type Layout, type SelfTestPlan } from "@vibread/core";
import { calibrationMacros, LineDecoder, evaluateRun, planSelfTest } from "./index.js";

const moon = GOLDEN.find((entry) => entry.key === "moon-phase-lamp");
if (moon === undefined) throw new Error("moon-phase-lamp fixture is required");

interface VirtualRun {
  lines: DeviceLine[];
  invalid: DecodedLine[];
  answers: Record<string, string>;
}

function mutateButton(base: Layout): Layout {
  const layout = structuredClone(base);
  const button = layout.placements.find((placement) => placement.part === "BTN1");
  const jumper = layout.jumpers.find((candidate) => candidate.id === "W3");
  if (button === undefined || jumper === undefined) throw new Error("moon layout must place BTN1 and its D2 jumper");
  // Put the signal leg and its D2 jumper in the GND contact group a31.
  button.pins["1"] = "a31";
  jumper.to = { hole: "a31" };
  return layout;
}

function mutateLedJumpers(base: Layout): Layout {
  const layout = structuredClone(base);
  const first = layout.jumpers.find((jumper) => jumper.id === "W5");
  const second = layout.jumpers.find((jumper) => jumper.id === "W6");
  if (first === undefined || second === undefined) throw new Error("moon layout must have D4/D5 jumpers");
  const endpoint = first.to;
  first.to = second.to;
  second.to = endpoint;
  return layout;
}

function mutateMissingDividerResistor(base: Layout): Layout {
  const layout = structuredClone(base);
  layout.placements = layout.placements.filter((placement) => placement.part !== "R5");
  return layout;
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
    // Let one pulse enter the rolling partState window, then answer as a person
    // looking at the physically lit LED (not merely the requested subject).
    session.run(plan.timing.ledPeriodMs);
    const ledSubjects = plan.subjects.filter((subject): subject is Extract<typeof plan.subjects[number], { kind: "led" }> => subject.kind === "led");
    const brightest = ledSubjects.reduce((best, subject) => session.partState(subject.part) > session.partState(best.part) ? subject : best, ledSubjects[0]);
    value = String(brightest.order);
  } else if (ask.kind === "heard-beep") {
    session.run(100);
    value = session.partState(ask.part ?? "BZ1") > 0 ? "yes" : "no";
  }
  answers[ask.id] = value;
  session.serialWrite(`${JSON.stringify({ c: "answer", id: ask.id, v: value })}\n`);
  answered.add(ask.id);
}

function runVirtual(circuit: Circuit, plan: SelfTestPlan, hex: string): VirtualRun {
  const session = new SimSession({ circuit, hex, light: { LDR1: 0.8 } });
  const decoder = new LineDecoder();
  const lines: DeviceLine[] = [];
  const invalid: DecodedLine[] = [];
  const answered = new Set<string>();
  const answers: Record<string, string> = {};
  session.onSerial((chunk) => {
    for (const decoded of decoder.push(chunk)) {
      if (decoded.t === "invalid") invalid.push(decoded);
      else {
        lines.push(decoded);
        if (decoded.t === "ask") answerForAsk(session, plan, decoded, answered, answers);
      }
    }
  });
  session.run(100);
  session.serialWrite('{"c":"run","test":"all"}\n');
  // Four LED prompt windows plus the read-only and ADC passes finish in < 5 s;
  // the simulator guard is cycle-derived, so this remains bounded and deterministic.
  session.run(5_000);
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

    const faults = [
      { name: "button", layout: mutateButton(goodLayout), cause: "button-leg-in-gnd-row" },
      { name: "leds", layout: mutateLedJumpers(goodLayout), cause: "led-jumpers-swapped" },
      { name: "divider", layout: mutateMissingDividerResistor(goodLayout), cause: "divider-resistor-missing" },
    ];
    for (const fault of faults) {
      const asBuilt = asBuiltCircuit(moon.circuit, fault.layout);
      const run = runVirtual(asBuilt, plan, compiled.hex);
      expect(run.invalid, `${fault.name}: ${JSON.stringify(run.invalid)}`).toHaveLength(0);
      const result = await evaluateRun({ circuit: moon.circuit, layout: fault.layout, plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: `virtual-${fault.name}` });
      expect(result.verdict, fault.name).toBe("fail");
      expect(result.diagnosis.candidates.slice(0, 2).map((candidate) => candidate.cause), `${fault.name}: ${JSON.stringify({ diagnosis: result.diagnosis, results: result.results })}`).toContain(fault.cause);
      expect(result.diagnosis.candidates[0]?.highlight.holes.length, fault.name).toBeGreaterThan(0);
    }
  }, 120_000);
});
