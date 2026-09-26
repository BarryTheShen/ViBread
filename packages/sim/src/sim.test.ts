import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { compileSketch } from "@vibread/firmware";
import { coverageOf, observePinModes, runScenario, runSuite } from "./index.js";
import { SimSession } from "./browser.js";
const blinkHex = readFileSync(new URL("../test-fixtures/Blink.ino.hex", import.meta.url), "utf8");
const echoHex = readFileSync(new URL("../test-fixtures/Echo.ino.hex", import.meta.url), "utf8");
const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp");
if (!moon) throw new Error("moon-phase-lamp fixture is required");

let wrongMoonHex: string | undefined;

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
