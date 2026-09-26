import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import type { SelfTestPlan } from "@vibread/core";
import { compileBenchFirmware, compileSketch, renderBenchFirmware } from "./index.js";

const board = "uno-r3-atmega328p-5v" as const;

const launchPlan: SelfTestPlan = {
  schema: "vibread.selftest/1",
  design: "launch-test",
  board,
  subjects: [
    { kind: "button", part: "BTN1", pin: "D2", label: "ARM", pressedLevel: 0, pull: "internal-up" },
    { kind: "button", part: "BTN2", pin: "D4", label: "LAUNCH", pressedLevel: 0, pull: "internal-up" },
    { kind: "led", part: "LED1", pin: "D3", label: "red", activeHigh: true, order: 1 },
    { kind: "led", part: "LED2", pin: "D5", label: "yellow", activeHigh: true, order: 2 },
    { kind: "led", part: "LED3", pin: "D6", label: "green", activeHigh: true, order: 3 },
    { kind: "buzzer", part: "BZ1", pin: "D8", label: "liftoff", active: true },
  ],
  tests: ["rails.vcc", "pins.readonly", "button.interactive", "led.sequence", "buzzer.confirm"],
  timing: { ledOnMs: 5, ledPeriodMs: 50, ledPulses: 2, promptTimeoutMs: 100, samples: 3 },
};

describe("firmware compiler", () => {
  it("compiles every golden sketch and returns application artifacts", async () => {
    for (const fixture of GOLDEN) {
      const result = await compileSketch({ source: fixture.circuit.sketch.source, board: fixture.circuit.board.profile });
      expect(result.ok, fixture.key).toBe(true);
      expect(result.hex?.length, fixture.key).toBeGreaterThan(0);
      expect(result.sizes?.flashBytes, fixture.key).toBeTypeOf("number");
      expect(result.sizes?.ramBytes, fixture.key).toBeTypeOf("number");
    }
  }, 30_000);

  it("maps compiler diagnostics to user sketch lines after define injection", async () => {
    const result = await compileSketch({
      board,
      defines: { VB_CAL_CHECK: 42 },
      source: "void setup(){}\nvoid loop(){this_is_broken();}\n",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.file === "sketch.ino" && diagnostic.line === 2)).toBe(true);
  }, 30_000);

  it("uses calibration defines to override guarded defaults at compile time", async () => {
    const result = await compileSketch({
      board,
      defines: { VB_CAL_CHECK: 42 },
      source: "#ifndef VB_CAL_CHECK\n#define VB_CAL_CHECK 0\n#endif\n#if VB_CAL_CHECK != 42\n#error calibration_not_applied\n#endif\nvoid setup(){}\nvoid loop(){}\n",
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it("renders and compiles the launch self-test within Uno budgets", async () => {
    const source = renderBenchFirmware(launchPlan);
    expect(source).toContain('PSTR("led1")');
    expect(source).toContain('PSTR("btn0-press")');
    expect(source).toContain('PSTR("btn1-release")');
    expect(source).toContain('PSTR("pressed")');
    expect(source).toContain('"which-led"');
    const result = await compileBenchFirmware(launchPlan);
    expect(result.ok).toBe(true);
    expect(result.sizes?.flashBytes).toBeLessThan(result.sizes?.flashMax ?? 0);
    expect(result.sizes?.ramBytes).toBeLessThan(result.sizes?.ramMax ?? 0);
  }, 30_000);

  it("rejects LED safety-limit violations before compiling", () => {
    expect(() => renderBenchFirmware({ ...launchPlan, timing: { ...launchPlan.timing, ledOnMs: 6 } })).toThrow(/ledOnMs/);
  });

  it("keeps concurrent compile artifacts isolated", async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => compileSketch({ source: "void setup(){} void loop(){}", board })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.elfPath)).size).toBe(3);
  }, 30_000);
});
