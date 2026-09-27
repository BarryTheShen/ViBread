import { describe, expect, it } from "vitest";
import { moonPhaseLamp } from "@vibread/fixtures";
import { revisionHash, type DeviceLine, type Layout } from "@vibread/core";
import { calibrationMacros, evaluateRun, LineDecoder, planSelfTest, promptFor } from "./index.js";

const hash = revisionHash(moonPhaseLamp);
const plan = planSelfTest(moonPhaseLamp, hash);

const layout: Layout = {
  schema: "vibread.layout/1",
  board: "uno-r3-atmega328p-5v",
  breadboard: "bb-830",
  placements: [
    { part: "BTN1", pins: { "1": "a17", "2": "b17", "3": "c17", "4": "d17" } },
    { part: "LED2", pins: { A: "a20", K: "a21" } },
    { part: "LED3", pins: { A: "a22", K: "a23" } },
    { part: "LDR1", pins: { "1": "a12", "2": "a13" } },
    { part: "R5", pins: { "1": "b13", "2": "b14" } },
  ],
  jumpers: [
    { id: "W1", from: { board: "GND" }, to: { hole: "e17" }, color: "black", net: "GND" },
    { id: "W2", from: { board: "D4" }, to: { hole: "a20" }, color: "yellow", net: "D4" },
    { id: "W3", from: { board: "D5" }, to: { hole: "a22" }, color: "green", net: "D5" },
  ],
};

function header(): DeviceLine[] {
  return [
    { t: "hello", fw: "vibread-bench", proto: 1, design: plan.design, board: plan.board },
    { t: "vcc", mv: 5000 },
  ];
}

function pins(readD2 = 32): DeviceLine[] {
  return [
    { t: "begin", test: "pins.readonly" },
    { t: "read", pin: "D2", pull: 1, ones: readD2, n: 32 },
    { t: "probe", pin: "D3", drive: 1, readback: 1 },
    { t: "probe", pin: "D4", drive: 1, readback: 1 },
    { t: "probe", pin: "D5", drive: 1, readback: 1 },
    { t: "probe", pin: "D6", drive: 1, readback: 1 },
    { t: "read", pin: "A0", pull: 0, ones: 16, n: 32 },
    { t: "read", pin: "A0", pull: 1, ones: 16, n: 32 },
    { t: "end", test: "pins.readonly", status: "pass" },
  ];
}

async function run(lines: DeviceLine[], answers: Record<string, string>, runLayout: Layout | undefined = layout) {
  return evaluateRun({ circuit: moonPhaseLamp, plan, layout: runLayout, lines: [...header(), ...lines], answers, kind: "selftest", revision: 1, runId: "test" });
}
const railPlan: typeof plan = { ...plan, tests: ["rails.vcc"] };

async function evaluateRails(mv?: number, options: { hello?: false | { design: string; board: string }; begin?: boolean; kind?: "rails" | "selftest" } = {}) {
  const lines: DeviceLine[] = [];
  const hello = options.hello === undefined ? { design: plan.design, board: plan.board } : options.hello;
  if (hello) lines.push({ t: "hello", fw: "vibread-bench", proto: 1, ...hello });
  if (options.begin) lines.push({ t: "begin", test: "rails.vcc" });
  if (mv !== undefined) lines.push({ t: "vcc", mv });
  const result = await evaluateRun({
    circuit: moonPhaseLamp,
    plan: { ...railPlan, tests: ["rails.vcc"] },
    layout,
    lines,
    answers: {},
    kind: options.kind ?? "rails",
    revision: 1,
    runId: "rail-test",
  });
  const rail = result.results.find((candidate) => candidate.test === "rails.vcc");
  if (rail === undefined) throw new Error("rails.vcc result missing");
  return { rail, result };
}

async function evaluateRail(mv?: number, options: Parameters<typeof evaluateRails>[1] = {}) {
  return (await evaluateRails(mv, options)).rail;
}


describe("bench self-test", () => {
  it.each([
    [4400, "fail"],
    [4490, "fail"],
    [4500, "pass"],
    [5001, "pass"],
    [5500, "pass"],
    [5510, "fail"],
  ] as const)("evaluates the board-power VCC window at %d mV", async (mv, status) => {
    const rail = await evaluateRail(mv);
    expect(rail.status).toBe(status);
    expect(rail.reason).toBeUndefined();
    expect(rail.subjects[0]).toMatchObject({ part: "board power", observed: `${mv} mV` });
  });

  it("reports a power check that began but never read VCC as a short-suspected power loss", async () => {
    const { rail, result } = await evaluateRails(undefined, { begin: true });
    expect(rail.status).toBe("fail");
    expect(rail.reason).toBe("short-suspected");
    expect(rail.summary).toBe("The board lost power or stopped answering when you plugged in — unplug now and check for a short between the red + and blue − rails, or a part bridging them");
    expect(result.diagnosis.attribution).toBe("wiring");
  });

  it("keeps a board that said hello but never began the power check unknown", async () => {
    const rail = await evaluateRail(undefined);
    expect(rail.status).toBe("unknown");
    expect(rail.reason).toBeUndefined();
    expect(rail.subjects[0]).toMatchObject({ observed: "no board VCC reading" });
  });

  it("keeps a board that sent nothing at all unknown", async () => {
    const rail = await evaluateRail(undefined, { hello: false, kind: "selftest" });
    expect(rail.status).toBe("unknown");
    expect(rail.reason).toBeUndefined();
    expect(rail.subjects[0]).toMatchObject({ part: "board power", observed: "no hello banner or board VCC reading" });
  });

  it.each([false, true])("blames a wrong-design banner on the firmware, not a short (power check begun: %s)", async (begin) => {
    const { rail, result } = await evaluateRails(undefined, { hello: { design: "other-design", board: plan.board }, begin });
    expect(rail.status).toBe("fail");
    expect(rail.reason).toBeUndefined();
    expect(rail.summary).toContain("design other-design");
    expect(result.verdict).toBe("fail");
    expect(result.diagnosis.attribution).toBe("design");
    expect(result.diagnosis.candidates).toEqual([]);
    expect(result.diagnosis.summary).toContain("banner says design other-design");
    expect(result.diagnosis.summary).toContain("Flash this design's safe firmware again");
  });

  it("blames a banner for another board on the firmware too", async () => {
    const { result } = await evaluateRails(undefined, { hello: { design: plan.design, board: "nano-atmega328p-5v" }, begin: true });
    expect(result.diagnosis.attribution).toBe("design");
    expect(result.diagnosis.summary).toContain("board nano-atmega328p-5v");
  });

  it("derives safe subjects, order, timings, and friendly prompts", () => {
    expect(plan.tests).toEqual(["rails.vcc", "pins.readonly", "button.interactive", "light.relative", "led.sequence"]);
    expect(plan.timing).toEqual({ ledOnMs: 5, ledPeriodMs: 50, ledPulses: 20, promptTimeoutMs: 20_000, samples: 32 });
    expect(plan.subjects.filter((subject) => subject.kind === "led").map((subject) => subject.order)).toEqual([1, 2, 3, 4]);
    expect(plan.subjects.find((subject) => subject.kind === "light")).toMatchObject({ brighterReadsHigher: true });
    expect(promptFor({ t: "ask", id: "a", test: "button.interactive", kind: "press-hold", part: "BTN1", choices: ["done"], timeoutMs: 20_000 }, plan).body).toBe("Press and hold the Next-phase button, then tap Done");
    expect(promptFor({ t: "ask", id: "b", test: "led.sequence", kind: "which-led", choices: ["1", "2"], timeoutMs: 20_000 }, plan).body).toBe("Which light is blinking? 1 is the leftmost");
  });

  it("decodes split NDJSON and boot noise", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("bootloader noise\r\n{\"t\":\"vcc\"")[0]).toEqual({ t: "invalid", raw: "bootloader noise" });
    expect(decoder.push(",\"mv\":5000}\r\n")).toEqual([{ t: "vcc", mv: 5000 }]);
  });

  it("passes the moon lamp and emits calibration macros", async () => {
    const result = await run([
      ...pins(),
      { t: "begin", test: "button.interactive" },
      { t: "ask", id: "btn0-press", test: "button.interactive", kind: "press-hold", part: "BTN1", choices: ["done"], timeoutMs: 20_000 },
      { t: "obs", test: "button.interactive", part: "BTN1", key: "pressed", v: 0 },
      { t: "ask", id: "btn0-release", test: "button.interactive", kind: "release", part: "BTN1", choices: ["done"], timeoutMs: 20_000 },
      { t: "obs", test: "button.interactive", part: "BTN1", key: "released", v: 1 },
      { t: "end", test: "button.interactive", status: "pass" },
      { t: "begin", test: "light.relative" },
      { t: "adc", pin: "A0", phase: "ambient", med: 800, min: 790, max: 810, n: 32 },
      { t: "ask", id: "light0-cover", test: "light.relative", kind: "cover", part: "LDR1", choices: ["done"], timeoutMs: 20_000 },
      { t: "adc", pin: "A0", phase: "covered", med: 200, min: 190, max: 210, n: 32 },
      { t: "ask", id: "light0-uncover", test: "light.relative", kind: "uncover", part: "LDR1", choices: ["done"], timeoutMs: 20_000 },
      { t: "end", test: "light.relative", status: "pass" },
      { t: "begin", test: "led.sequence" },
      ...[1, 2, 3, 4].map((n) => ({ t: "ask" as const, id: `led${n}`, test: "led.sequence" as const, kind: "which-led" as const, part: `LED${n}`, choices: ["1", "2", "3", "4"], timeoutMs: 20_000 })),
      { t: "end", test: "led.sequence", status: "pass" },
    ], { "btn0-press": "done", "btn0-release": "done", "light0-cover": "done", "light0-uncover": "done", led1: "1", led2: "2", led3: "3", led4: "4" });
    expect(result.verdict).toBe("pass");
    expect(calibrationMacros(result.calibration)).toEqual({ VB_CAL_LDR1_DARK: 500, VB_CAL_LDR1_HYST: 60 });
  });

  it("ranks the button GND-row fault and highlights shared holes", async () => {
    const result = await run([...pins(0)], {});
    expect(result.verdict).toBe("fail");
    expect(result.diagnosis.candidates[0]?.cause).toBe("button-leg-in-gnd-row");
    expect(result.diagnosis.candidates[0]?.highlight.holes).toEqual(expect.arrayContaining(["c17", "e17"]));
    expect(result.diagnosis.candidates[1]?.cause).toBe("button-rotated-90");
  });

  it("ranks a pinned light divider as a missing resistor", async () => {
    const result = await run([
      ...pins(),
      { t: "begin", test: "light.relative" },
      { t: "adc", pin: "A0", phase: "ambient", med: 1023, min: 1023, max: 1023, n: 32 },
      { t: "adc", pin: "A0", phase: "covered", med: 1023, min: 1023, max: 1023, n: 32 },
      { t: "end", test: "light.relative", status: "fail" },
    ], {});
    expect(result.diagnosis.candidates[0]?.cause).toBe("divider-resistor-missing");
  });

  it("ranks swapped LED answers and never recommends driving a stuck output", async () => {
    const swapped = await run([
      ...pins(),
      { t: "begin", test: "led.sequence" },
      { t: "ask", id: "led1", test: "led.sequence", kind: "which-led", part: "LED1", choices: ["1", "2", "3", "4", "none"], timeoutMs: 20_000 },
      { t: "ask", id: "led2", test: "led.sequence", kind: "which-led", part: "LED2", choices: ["1", "2", "3", "4", "none"], timeoutMs: 20_000 },
      { t: "ask", id: "led3", test: "led.sequence", kind: "which-led", part: "LED3", choices: ["1", "2", "3", "4", "none"], timeoutMs: 20_000 },
      { t: "ask", id: "led4", test: "led.sequence", kind: "which-led", part: "LED4", choices: ["1", "2", "3", "4", "none"], timeoutMs: 20_000 },
      { t: "end", test: "led.sequence", status: "fail" },
    ], { led1: "1", led2: "3", led3: "2", led4: "4" });
    expect(swapped.diagnosis.candidates[0]?.cause).toBe("led-jumpers-swapped");

    const stuck = await run([{ t: "begin", test: "pins.readonly" }, { t: "stuck", pin: "D3", level: 1 }, { t: "end", test: "pins.readonly", status: "fail" }], {});
    expect(stuck.results.find((result) => result.test === "digital.stuck")?.status).toBe("fail");
    expect(stuck.diagnosis.candidates.every((candidate) => !candidate.fix.toLowerCase().includes("drive"))).toBe(true);
  });
});
