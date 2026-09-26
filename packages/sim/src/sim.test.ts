import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { compileSketch } from "@vibread/firmware";
import type { Scenario } from "@vibread/core";
import { coverageOf, observePinModes, runScenario, runSuite } from "./index.js";
import { SimSession } from "./browser.js";
const blinkHex = readFileSync(new URL("../test-fixtures/Blink.ino.hex", import.meta.url), "utf8");
const blink25Hex = readFileSync(new URL("../test-fixtures/Blink25.ino.hex", import.meta.url), "utf8");
const echoHex = readFileSync(new URL("../test-fixtures/Echo.ino.hex", import.meta.url), "utf8");
const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp");
if (!moon) throw new Error("moon-phase-lamp fixture is required");

let wrongMoonHex: string | undefined;
function knobDutyScenario(id: "T25" | "T75", level: number): Scenario {
  return {
    id,
    title: `Knob duty at ${level}`,
    clauses: ["C1"],
    categories: ["normal"],
    setup: { analog: { POT1: level } },
    steps: [
      { wait: 200 },
      { "expect-pwm": { pin: "D9", min: level - 0.03, max: level + 0.03, windowMs: 200 } },
    ],
  };
}

describe("avr8js golden simulation", () => {
  beforeAll(async () => {
    const wrongSource = moon.circuit.sketch.source.replace(
      /const uint8_t PHASES\[8\] = \{[\s\S]*?\n\};/,
      `const uint8_t PHASES[8] = {
  0b0000,
  0b0001,
  0b0011,
  0b0111,
  0b1111,
  0b1110,
  0b1100,
  0b1000,
};`,
    );
    const compiled = await compileSketch({ source: wrongSource, board: moon.circuit.board.profile });
    if (!compiled.ok || !compiled.hex) throw new Error(`wrong moon compile failed: ${compiled.log}`);
    wrongMoonHex = compiled.hex;
  }, 120_000);

  it("passes every golden suite against its cached HEX", async () => {
    const reports = [];
    for (const design of GOLDEN) {
      const hex = readFileSync(design.hexFile, "utf8");
      const result = await runSuite({ circuit: design.circuit, hex, suite: design.suite, revisionHash: design.key, recordTraces: true });
      reports.push(`${design.key}:${result.report.verdict}`);
      expect(result.report.verdict, reports.join(",")).toBe("GO");
      expect(result.scenarios.every((scenario) => scenario.ok), design.key).toBe(true);
      expect(result.coverage.ok, design.key).toBe(true);
      expect(result.traces).toHaveLength(design.suite.scenarios.length);
    }
  }, 60_000);

  it("rejects the moon sketch that fills from the left", async () => {
    if (!wrongMoonHex) throw new Error("wrong moon HEX was not compiled");
    const results = new Map<string, boolean>();
    for (const scenario of moon.suite.scenarios.slice(0, 4)) {
      const result = await runScenario({ circuit: moon.circuit, hex: wrongMoonHex, scenario });
      results.set(scenario.id, result.result.ok);
    }
    expect(results.get("T1")).toBe(true);
    expect(results.get("T2")).toBe(false);
    expect(results.get("T3")).toBe(false);
    expect(results.get("T4")).toBe(false);
  }, 60_000);

  it("observes the moon lamp's declared pin roles", async () => {
    const observed = await observePinModes({ circuit: moon.circuit, hex: readFileSync(moon.hexFile, "utf8") });
    const modes = new Map(observed.map((entry) => [entry.pin, entry.mode]));
    for (const role of moon.circuit.roles) expect(modes.get(role.pin), role.pin).toBe(role.mode);
  }, 30_000);

  it("simulates Blink at virtual 1 Hz on PB5/D13", () => {
    const session = new SimSession({ circuit: moon.circuit, hex: blinkHex });
    session.run(100);
    expect(session.pinLevel("D13")).toBe(1);
    session.run(450);
    expect(session.pinLevel("D13")).toBe(0);
    session.run(500);
    expect(session.pinLevel("D13")).toBe(1);
  }, 30_000);
  it("measures knob PWM duty without inversion", async () => {
    const design = GOLDEN.find((entry) => entry.key === "knob-night-light");
    if (!design) throw new Error("knob fixture is required");
    for (const [id, level] of [["T25", 0.25] as const, ["T75", 0.75] as const]) {
      const outcome = await runScenario({ circuit: design.circuit, hex: readFileSync(design.hexFile, "utf8"), scenario: knobDutyScenario(id, level) });
      expect(outcome.result.ok, `${id}: ${outcome.result.steps.map((step) => step.message).join("; ")}`).toBe(true);
    }
  }, 30_000);

  it("measures a cached 25 percent Blink duty cycle", async () => {
    const scenario: Scenario = {
      id: "T25",
      title: "One-quarter duty Blink",
      clauses: ["C1"],
      categories: ["normal"],
      setup: {},
      steps: [
        { wait: 100 },
        { "expect-pwm": { pin: "D13", min: 0.22, max: 0.28, windowMs: 1_000 } },
      ],
    };
    const outcome = await runScenario({ circuit: moon.circuit, hex: blink25Hex, scenario });
    expect(outcome.result.ok, outcome.result.steps.map((step) => step.message).join("; ")).toBe(true);
  }, 30_000);
  it("reports expect-part time in the requested state", async () => {
    const design = GOLDEN.find((entry) => entry.key === "knob-night-light");
    if (!design) throw new Error("knob fixture is required");
    const off = await runScenario({ circuit: design.circuit, hex: readFileSync(design.hexFile, "utf8"), scenario: design.suite.scenarios[0] });
    const on = await runScenario({ circuit: design.circuit, hex: readFileSync(design.hexFile, "utf8"), scenario: design.suite.scenarios[1] });
    const offMessage = off.result.steps.find((step) => "expect-part" in step.step)?.message ?? "";
    const onMessage = on.result.steps.find((step) => "expect-part" in step.step)?.message ?? "";
    expect(offMessage).toContain("LED1 was off as expected (lit 0% of the window)");
    expect(onMessage).toContain("LED1 was on as expected (lit 100% of the window)");
    const failure: Scenario = {
      id: "T99",
      title: "Expected-on failure",
      clauses: ["C1"],
      categories: ["normal"],
      setup: { analog: { POT1: 0 } },
      steps: [{ wait: 100 }, { "expect-part": { part: "LED1", state: "on", windowMs: 100 } }],
    };
    const failed = await runScenario({ circuit: design.circuit, hex: readFileSync(design.hexFile, "utf8"), scenario: failure });
    const failureMessage = failed.result.steps.find((step) => "expect-part" in step.step)?.message ?? "";
    expect(failed.result.ok).toBe(false);
    expect(failureMessage).toContain("LED1 should be on (lit ≥ 90% of the window) but was lit 0%");
  }, 30_000);
  it("reports LED partState as lit-window duty", () => {
    const knob = GOLDEN.find((entry) => entry.key === "knob-night-light");
    if (!knob) throw new Error("knob fixture is required");
    const half = new SimSession({ circuit: knob.circuit, hex: readFileSync(knob.hexFile, "utf8"), analog: { POT1: 0.5 } });
    half.run(200);
    expect(half.partState("LED1")).toBeGreaterThanOrEqual(0.45);
    expect(half.partState("LED1")).toBeLessThanOrEqual(0.55);
    const full = new SimSession({ circuit: knob.circuit, hex: readFileSync(knob.hexFile, "utf8"), analog: { POT1: 1 } });
    full.run(200);
    expect(full.partState("LED1")).toBeGreaterThanOrEqual(0.97);
    const moonSession = new SimSession({ circuit: moon.circuit, hex: readFileSync(moon.hexFile, "utf8"), light: { LDR1: 0.05 } });
    moonSession.run(300);
    for (let press = 0; press < 4; press += 1) {
      moonSession.setDigital("BTN1", true);
      moonSession.run(120);
      moonSession.setDigital("BTN1", false);
      moonSession.run(150);
    }
    for (const part of ["LED1", "LED2", "LED3", "LED4"]) expect(moonSession.partState(part), part).toBeGreaterThanOrEqual(0.97);
  }, 30_000);

  it("reports the live tone() pitch of a passive buzzer and silence after noTone()", async () => {
    const source = `void setup() { pinMode(8, OUTPUT); }
void loop() {
  tone(8, 440); delay(300);
  tone(8, 1000); delay(300);
  noTone(8); delay(300);
}
`;
    const circuit = {
      ...moon.circuit,
      title: "Tone check",
      parts: [
        { id: "R1", module: "resistor" as const, params: { ohms: 1_000, tolerancePct: 5 } },
        { id: "BZ1", module: "buzzer-passive" as const, params: {} },
      ],
      nets: [
        { id: "D8", kind: "signal" as const, pins: [{ part: "board", pin: "D8" }, { part: "R1", pin: "1" }] },
        { id: "BZP", kind: "signal" as const, pins: [{ part: "R1", pin: "2" }, { part: "BZ1", pin: "P" }] },
        { id: "GND", kind: "ground" as const, pins: [{ part: "board", pin: "GND" }, { part: "BZ1", pin: "N" }] },
      ],
      roles: [{ pin: "D8", mode: "OUTPUT" as const, part: "BZ1", purpose: "tone" }],
      sketch: { source },
    };
    const compiled = await compileSketch({ source, board: circuit.board.profile });
    if (!compiled.ok || !compiled.hex) throw new Error(`tone sketch compile failed: ${compiled.log}`);
    const session = new SimSession({ circuit, hex: compiled.hex });
    session.run(200);
    expect(session.toneFrequency("BZ1", 50)).toBeCloseTo(440, -1);
    session.run(300);
    expect(session.toneFrequency("BZ1", 50)).toBeCloseTo(1000, -1);
    session.run(200);
    expect(session.toneFrequency("BZ1", 50)).toBe(0);
    const directCircuit = {
      ...circuit,
      parts: [{ id: "BZ1", module: "buzzer-passive" as const, params: {} }],
      nets: [
        { id: "D8", kind: "signal" as const, pins: [{ part: "board", pin: "D8" }, { part: "BZ1", pin: "P" }] },
        { id: "GND", kind: "ground" as const, pins: [{ part: "board", pin: "GND" }, { part: "BZ1", pin: "N" }] },
      ],
    };
    const directSession = new SimSession({ circuit: directCircuit, hex: compiled.hex });
    directSession.run(200);
    expect(directSession.toneFrequency("BZ1", 50)).toBeCloseTo(440, -1);
  }, 120_000);
  it("lights an LED whose cathode is on an INPUT_PULLUP key pin when pressed", async () => {
    const circuit = structuredClone(moon.circuit);
    circuit.title = "Key LED";
    circuit.parts = [
      { id: "LED1", module: "led", params: { color: "red" } },
      { id: "R1", module: "resistor", params: { ohms: 220, tolerancePct: 5 } },
      { id: "BTN1", module: "button", params: {} },
    ];
    circuit.nets = [
      { id: "5V", kind: "power", pins: [{ part: "board", pin: "5V" }, { part: "R1", pin: "1" }] },
      { id: "LEDK", kind: "signal", pins: [{ part: "R1", pin: "2" }, { part: "LED1", pin: "A" }] },
      { id: "KEY", kind: "signal", pins: [{ part: "board", pin: "D2" }, { part: "LED1", pin: "K" }, { part: "BTN1", pin: "1" }] },
      { id: "GND", kind: "ground", pins: [{ part: "board", pin: "GND" }, { part: "BTN1", pin: "3" }] },
    ];
    circuit.roles = [{ pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "key" }];
    circuit.sketch = { source: "void setup(){pinMode(2,INPUT_PULLUP);} void loop(){delay(1);}" };
    const compiled = await compileSketch({ source: circuit.sketch.source, board: circuit.board.profile });
    if (!compiled.ok || !compiled.hex) throw new Error(`key LED compile failed: ${compiled.log}`);
    const session = new SimSession({ circuit, hex: compiled.hex });
    session.run(100);
    expect(session.partState("LED1")).toBeLessThan(0.02);
    session.setDigital("BTN1", true);
    session.run(100);
    expect(session.partState("LED1")).toBeGreaterThan(0.02);
  }, 120_000);

  it("supports a SimSession serial round trip without RX overrun", () => {
    const session = new SimSession({ circuit: moon.circuit, hex: echoHex });
    let received = "";
    session.onSerial((text) => { received += text; });
    session.run(30);
    session.serialWrite("first\nsecond\n");
    session.run(100);
    expect(received).toContain("ready");
    expect(received).toContain("first");
    expect(received).toContain("second");
  }, 30_000);
});

describe("simulation coverage", () => {
  it("rejects a suite missing an output assertion", () => {
    const design = GOLDEN.find((entry) => entry.key === "knob-night-light");
    if (!design) throw new Error("knob fixture is required");
    const suite = {
      ...design.suite,
      scenarios: design.suite.scenarios.map((scenario) => ({
        ...scenario,
        steps: scenario.steps.filter((step) => !("expect-part" in step) && !("expect-pwm" in step)),
      })),
    };
    const coverage = coverageOf(design.circuit, suite);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain("LED1 is never checked");
  });

  it("requires a bounce category whenever a button exists", () => {
    const suite = { ...moon.suite, scenarios: moon.suite.scenarios.filter((scenario) => scenario.id !== "T6") };
    const coverage = coverageOf(moon.circuit, suite);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain("no bounce test");
  });
});
