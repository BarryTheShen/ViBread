import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * `vibread.sim/v1` — Wokwi-shaped scenario files the independent test author writes and the avr8js runner executes.
 *
 * Semantics (the simulator implements exactly this):
 *  - Virtual time starts at 0 at MCU reset. `setup` values hold from t = 0. Defaults when a part is not in `setup`:
 *    light level 0.8 (a lit room), analog 0.0, digital false (button released).
 *  - `wait` advances virtual time by N ms.
 *  - `set-digital` sets a button (true = pressed) or a generic digital sensor output level, instantly.
 *  - `press` = pressed, hold `holdMs`, released, then wait `gapMs`.
 *  - `bounce` = `edges` alternating contact changes spread evenly over `ms`, ending in state `to`; no extra wait.
 *  - `set-light` sets a photoresistor's relative light level 0 (dark) … 1 (bright); see `photoresistorOhms`.
 *  - `set-analog` sets a potentiometer wiper position 0 (at pin A) … 1 (at pin B), or a generic analog sensor output as a
 *    fraction of VCC.
 *  - `expect-pin` passes when a board pin's driven output level (the pin must be an OUTPUT) reaches `level` now or
 *    within the next 100 ms (advancing time only while it waits).
 *  - Window expectations are open-ended: the state may start or end anywhere inside the window.
 *  - `expect-part` watches a part for `windowMs` (advancing time): LED "on" = lit for at least 25 % of the window,
 *    "off" = dark for at least 25 % of it (lit ≤ 75 %); active buzzer "on"/"off" = sounding the same way.
 *  - `expect-parts` watches several parts over one shared `windowMs` (advancing time once); each check may specify
 *    `state` (as above), `minBrightness`, and/or `maxBrightness` (each bound with ±0.15 slack).
 *  - `expect-pwm` passes when the duty cycle is within `min`−0.10 … `max`+0.10 (clamped to 0…1).
 *  - `expect-tone` passes when the part sounds for at least 25 % of `windowMs` (anywhere in it; a late start or an
 *    on/off beep still counts) and the pitch — from the median spacing of its rising edges — is within
 *    `minHz`×0.85 … `maxHz`×1.15.
 *  - `expect-serial` passes when serial output since reset contains `contains`, waiting up to
 *    max(2 × `withinMs`, `withinMs` + 500 ms).
 *
 * `setAside` is written by ViBread only, never by the test author: the reason a failing scenario was judged wrong for the
 * intent by the independent test review. It still runs, but its failure is a FIDO warning, never a NO-GO.
 */
export const SIM_SCHEMA = "vibread.sim/v1" as const;

const part = z.string().min(1);
const ms = z.number().int().positive().max(60_000);
const expectPartCheck = z.object({
  part,
  state: z.enum(["on", "off"]).optional(),
  minBrightness: z.number().min(0).max(1).optional(),
  maxBrightness: z.number().min(0).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === undefined && value.minBrightness === undefined && value.maxBrightness === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "expect-parts check needs state or a brightness bound." });
  }
  if (value.minBrightness !== undefined && value.maxBrightness !== undefined && value.minBrightness > value.maxBrightness) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "expect-parts minBrightness cannot exceed maxBrightness." });
  }
});
const expectPartsPayload = z.object({ checks: z.array(expectPartCheck).min(1), windowMs: ms.default(50) }).strict();

export const ScenarioStepSchema = z.union([
  z.object({ wait: ms }).strict(),
  z.object({ "set-digital": z.object({ part, value: z.boolean() }).strict() }).strict(),
  z.object({ press: z.object({ part, holdMs: ms.default(120), gapMs: z.number().int().nonnegative().max(60_000).default(150) }).strict() }).strict(),
  z.object({ bounce: z.object({ part, to: z.boolean(), edges: z.number().int().min(2).max(20).default(6), ms: z.number().positive().max(30).default(8) }).strict() }).strict(),
  z.object({ "set-light": z.object({ part, level: z.number().min(0).max(1) }).strict() }).strict(),
  z.object({ "set-analog": z.object({ part, value: z.number().min(0).max(1) }).strict() }).strict(),
  z.object({ "expect-pin": z.object({ pin: z.string().min(1), level: z.enum(["high", "low"]) }).strict() }).strict(),
  z.object({ "expect-part": z.object({ part, state: z.enum(["on", "off"]), windowMs: ms.default(50) }).strict() }).strict(),
  z.object({ "expect-parts": expectPartsPayload }).strict(),
  z.object({ kind: z.literal("expect-parts"), checks: z.array(expectPartCheck).min(1), windowMs: ms.default(50) }).strict(),
  z.object({ "expect-pwm": z.object({ pin: z.string().min(1), min: z.number().min(0).max(1), max: z.number().min(0).max(1), windowMs: ms.default(100) }).strict() }).strict(),
  z.object({ "expect-tone": z.object({ part, minHz: z.number().positive(), maxHz: z.number().positive(), windowMs: ms.default(200) }).strict() }).strict(),
  z.object({ "expect-serial": z.object({ contains: z.string().min(1), withinMs: z.number().int().nonnegative().max(60_000).default(0) }).strict() }).strict(),
]);
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

/** Edge-case categories the coverage rules look for (bounce/rapid need a button; threshold/hysteresis need an analog input). */
export const SCENARIO_CATEGORIES = ["normal", "power-on", "bounce", "rapid", "threshold", "hysteresis", "edge"] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

export const ScenarioSchema = z.object({
  id: z.string().regex(/^T\d+$/),
  /** Plain-language line the human reads at GO ("In the dark, pressing the button 3 times lights 3 LEDs from the right"). */
  title: z.string().min(1),
  clauses: z.array(z.string().regex(/^C\d+$/)).min(1),
  categories: z.array(z.enum(SCENARIO_CATEGORIES)).min(1),
  setup: z
    .object({
      light: z.record(z.string(), z.number().min(0).max(1)).optional(),
      analog: z.record(z.string(), z.number().min(0).max(1)).optional(),
      digital: z.record(z.string(), z.boolean()).optional(),
    })
    .strict()
    .default({}),
  steps: z.array(ScenarioStepSchema).min(1),
  /** Set by ViBread when the test review judged this scenario wrong for the intent (the reason); see above. */
  setAside: z.string().min(1).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const TestSuiteSchema = z.object({
  schema: z.literal(SIM_SCHEMA),
  author: z.enum(["test-author", "fixture", "human"]),
  scenarios: z.array(ScenarioSchema).min(1),
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

export function parseSuiteYaml(text: string): TestSuite {
  return TestSuiteSchema.parse(parseYaml(text));
}

export function suiteToYaml(suite: TestSuite): string {
  return stringifyYaml(suite);
}
