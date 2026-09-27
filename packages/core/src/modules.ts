import { z } from "zod";
import type { ElectricalType } from "./electrical.js";

export const MODULE_KEYS = [
  "led",
  "resistor",
  "button",
  "photoresistor",
  "potentiometer",
  "buzzer-active",
  "buzzer-passive",
  "generic",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const LED_COLORS = ["red", "yellow", "green", "blue", "white", "orange", "pink", "purple", "warm-white"] as const;
export type LedColor = (typeof LED_COLORS)[number];

export interface LedVf {
  min: number;
  typ: number;
  max: number;
}

/** Conservative fallback when a user names an LED colour without Vf data. */
export const DEFAULT_LED_VF: LedVf = { min: 1.8, typ: 2.6, max: 3.4 };

const LED_VF_TABLE: Record<LedColor, LedVf> = {
  red: { min: 1.8, typ: 2.0, max: 2.2 },
  yellow: { min: 1.9, typ: 2.1, max: 2.4 },
  green: { min: 1.9, typ: 2.2, max: 3.2 },
  blue: { min: 2.8, typ: 3.1, max: 3.4 },
  white: { min: 2.8, typ: 3.1, max: 3.4 },
  orange: { min: 1.8, typ: 2.0, max: 2.2 },
  pink: { min: 1.8, typ: 2.2, max: 2.6 },
  purple: { min: 2.4, typ: 3.0, max: 3.4 },
  "warm-white": { min: 2.8, typ: 3.1, max: 3.4 },
};

export interface ModulePin {
  id: string;
  name: string;
  etype: ElectricalType;
  polarity?: "+" | "-";
}

/**
 * How a part sits on the breadboard (research/07):
 *  - two-lead: both leads in the same column group, `span` rows apart (LED legs are adjacent rows; a 1/4 W resistor spans ~4 rows).
 *  - button4: 6 mm tactile switch straddling the channel. Pin 1 at e<r>, pin 2 at f<r>, pin 3 at e<r+2>, pin 4 at f<r+2>.
 *    Pins 1–2 and 3–4 are always connected; pressing joins {1,2} with {3,4}, i.e. row r to row r+2.
 *    Rotated 90° the always-connected pairs bridge rows r and r+2 permanently ("button always pressed").
 *  - inline3: three leads in adjacent rows of one column group, in the listed pin order.
 *  - generic-inline: one lead per adjacent row, in the part's pinout order.
 */
export type Footprint =
  | { kind: "two-lead"; pins: [string, string]; minSpan: number; maxSpan: number; preferredSpan: number; polarized: boolean }
  | { kind: "button4" }
  | { kind: "inline3"; pins: [string, string, string] }
  | { kind: "generic-inline" };

export type SimModelId = ModuleKey;
export type SelfTestKind = "led" | "button" | "light" | "pot" | "buzzer" | "digital-in" | "analog-in";

export interface ModuleElectrical {
  /** LED forward voltage corners by color (V). */
  vf?: Record<string, LedVf>;
  ifDesignMa?: number;
  ifAbsMa?: number;
  defaultTolerancePct?: number;
  powerW?: number;
  /** Photoresistor (GL5528 class): dark ≥ 1 MΩ, 8–20 kΩ at 10 lux. Never judged on absolute values. */
  darkOhmsMin?: number;
  lux10Ohms?: { min: number; max: number };
  /** Active buzzer supply current at 5 V (mA). */
  currentMa?: number;
  /** Passive magnetic buzzer coil resistance and the minimum series resistor that keeps a pin under its limit. */
  coilOhms?: number;
  minSeriesOhms?: number;
  /** Typical contact bounce (ms). */
  bounceMs?: number;
}

export interface ModuleDef {
  key: ModuleKey;
  name: string;
  /** Plain-language description for beginners and for the design agent. */
  description: string;
  category: "output" | "input" | "passive";
  /** Empty for `generic`: generic parts carry their own `pinout` in the IR. */
  pins: ModulePin[];
  params: z.ZodType<Record<string, unknown>>;
  electrical: ModuleElectrical;
  sim: SimModelId;
  footprint: Footprint;
  selftest: SelfTestKind | null;
  /** Pin groups joined inside the part at all times (button pairs). */
  internallyConnected?: string[][];
  /** Where the numbers come from. */
  evidence: string[];
}

const ledParams = z.object({
  color: z.string().trim().min(1).max(32).default("red"),
  vf: z.object({
    min: z.number().positive(),
    typ: z.number().positive(),
    max: z.number().positive(),
  }).superRefine((value, context) => {
    if (!(value.min <= value.typ && value.typ <= value.max)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "LED Vf must satisfy min ≤ typ ≤ max." });
    }
  }).optional(),
});
const resistorParams = z.object({ ohms: z.number().positive(), tolerancePct: z.number().positive().default(5) });
const potParams = z.object({ ohms: z.number().positive().default(10_000) });
const emptyParams = z.object({});
const genericParams = z.object({
  role: z.enum(["digital-sensor", "analog-sensor", "digital-actuator"]),
  description: z.string().min(1),
});

export const MODULES: Record<ModuleKey, ModuleDef> = {
  led: {
    key: "led",
    name: "LED",
    description: "A small light. Current flows one way only: long leg (anode, +) toward the Arduino pin, short leg (cathode, −) toward GND. Always needs a resistor in series.",
    category: "output",
    pins: [
      { id: "A", name: "anode (+, long leg)", etype: "passive", polarity: "+" },
      { id: "K", name: "cathode (−, short leg, flat side)", etype: "passive", polarity: "-" },
    ],
    params: ledParams,
    electrical: {
      vf: LED_VF_TABLE,
      ifDesignMa: 20,
      ifAbsMa: 30,
    },
    sim: "led",
    footprint: { kind: "two-lead", pins: ["A", "K"], minSpan: 1, maxSpan: 1, preferredSpan: 1, polarized: true },
    selftest: "led",
    evidence: [
      "Red/yellow/green/blue/white 5 mm indicator LED datasheet-typical ranges (research/03; green covers both GaP and InGaN families).",
      "Orange/pink/purple/warm-white 5 mm indicator LED datasheet-typical ranges (research/03; vendor-family ranges).",
      "A user colour may supply Vf corners; otherwise checks conservatively assume 1.8/2.6/3.4 V.",
    ],
  },
  resistor: {
    key: "resistor",
    name: "Resistor",
    description: "Limits current. Either way round. The colored bands tell its value.",
    category: "passive",
    pins: [
      { id: "1", name: "lead 1", etype: "passive" },
      { id: "2", name: "lead 2", etype: "passive" },
    ],
    params: resistorParams,
    electrical: { defaultTolerancePct: 5, powerW: 0.25 },
    sim: "resistor",
    footprint: { kind: "two-lead", pins: ["1", "2"], minSpan: 3, maxSpan: 6, preferredSpan: 4, polarized: false },
    selftest: null,
    evidence: ["1/4 W carbon-film resistor, 0.4 in lead bend; E12/E24 values"],
  },
  button: {
    key: "button",
    name: "Push button",
    description: "A 4-leg push button. It sits across the middle gap of the breadboard. Legs 1–2 are always joined, legs 3–4 are always joined, and pressing joins the two pairs.",
    category: "input",
    pins: [
      { id: "1", name: "leg 1", etype: "passive" },
      { id: "2", name: "leg 2", etype: "passive" },
      { id: "3", name: "leg 3", etype: "passive" },
      { id: "4", name: "leg 4", etype: "passive" },
    ],
    params: emptyParams,
    electrical: { bounceMs: 5 },
    sim: "button",
    footprint: { kind: "button4" },
    selftest: "button",
    internallyConnected: [
      ["1", "2"],
      ["3", "4"],
    ],
    evidence: ["6 × 6 mm tactile switch: 6.5 × 4.5 mm lead pitch; contact bounce typically < 10 ms"],
  },
  photoresistor: {
    key: "photoresistor",
    name: "Light sensor (photoresistor)",
    description: "Its resistance drops when light hits it. Paired with a fixed resistor it makes a voltage the Arduino can read on an A pin.",
    category: "input",
    pins: [
      { id: "1", name: "lead 1", etype: "passive" },
      { id: "2", name: "lead 2", etype: "passive" },
    ],
    params: emptyParams,
    electrical: { darkOhmsMin: 1_000_000, lux10Ohms: { min: 8_000, max: 20_000 } },
    sim: "photoresistor",
    footprint: { kind: "two-lead", pins: ["1", "2"], minSpan: 1, maxSpan: 3, preferredSpan: 2, polarized: false },
    selftest: "light",
    evidence: ["GL5528-class CdS cell: 8–20 kΩ at 10 lux, ≥ 1 MΩ dark (research/03 §light sensors)"],
  },
  potentiometer: {
    key: "potentiometer",
    name: "Knob (potentiometer)",
    description: "A knob with three legs. The outer legs go to 5V and GND; the middle leg (wiper) gives a voltage that follows the knob.",
    category: "input",
    pins: [
      { id: "A", name: "outer leg A", etype: "passive" },
      { id: "W", name: "middle leg (wiper)", etype: "passive" },
      { id: "B", name: "outer leg B", etype: "passive" },
    ],
    params: potParams,
    electrical: { defaultTolerancePct: 20 },
    sim: "potentiometer",
    footprint: { kind: "inline3", pins: ["A", "W", "B"] },
    selftest: "pot",
    evidence: ["Breadboard trimmer/rotary pot, 0.1 in pin pitch, ±20 % track tolerance"],
  },
  "buzzer-active": {
    key: "buzzer-active",
    name: "Buzzer (active)",
    description: "Beeps by itself when its + leg gets 5 V. Has a + mark on top; + goes toward the Arduino pin.",
    category: "output",
    pins: [
      { id: "P", name: "+ (long leg)", etype: "passive", polarity: "+" },
      { id: "N", name: "− (short leg)", etype: "passive", polarity: "-" },
    ],
    params: emptyParams,
    electrical: { currentMa: 30 },
    sim: "buzzer-active",
    footprint: { kind: "two-lead", pins: ["P", "N"], minSpan: 3, maxSpan: 3, preferredSpan: 3, polarized: true },
    selftest: "buzzer",
    evidence: ["12 mm 5 V active magnetic buzzer: ~30 mA typical at 5 V, 7.6 mm lead pitch"],
  },
  "buzzer-passive": {
    key: "buzzer-passive",
    name: "Buzzer (passive)",
    description: "Makes a tone only when the Arduino plays one with tone(). Needs a small resistor in series.",
    category: "output",
    pins: [
      { id: "P", name: "+", etype: "passive", polarity: "+" },
      { id: "N", name: "−", etype: "passive", polarity: "-" },
    ],
    params: emptyParams,
    // 16 Ω coil + 100 Ω pulls 5.25 V / (16 + 95) Ω ≈ 47 mA, past the 40 mA pin maximum; 150 Ω (≈ 33 mA) is the smallest kit value that stays under it.
    electrical: { coilOhms: 16, minSeriesOhms: 150 },
    sim: "buzzer-passive",
    footprint: { kind: "two-lead", pins: ["P", "N"], minSpan: 3, maxSpan: 3, preferredSpan: 3, polarized: true },
    selftest: "buzzer",
    evidence: ["12 mm passive magnetic transducer: ~16 Ω coil; a series resistor keeps the pin current in limits"],
  },
  generic: {
    key: "generic",
    name: "Other part (generic)",
    description: "A part outside the library, described by its pinout. Simulated with basic logic only and always labeled unverified.",
    category: "input",
    pins: [],
    params: genericParams,
    electrical: {},
    sim: "generic",
    footprint: { kind: "generic-inline" },
    selftest: null,
    evidence: ["User-supplied pinout"],
  },
};
function isLedVf(value: unknown): value is LedVf {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const min = candidate.min;
  const typ = candidate.typ;
  const max = candidate.max;
  return typeof min === "number" && Number.isFinite(min)
    && typeof typ === "number" && Number.isFinite(typ)
    && typeof max === "number" && Number.isFinite(max)
    && min > 0 && min <= typ && typ <= max;
}

/** True when the colour is user-defined without a valid Vf override. */
export function ledVfAssumed(params: Readonly<Record<string, unknown>>): boolean {
  const color = typeof params.color === "string" ? params.color : "red";
  return !Object.hasOwn(LED_VF_TABLE, color) && !isLedVf(params.vf);
}

/** Resolve a built-in or user-defined LED colour to one Vf corner triple. */
export function ledVf(params: Readonly<Record<string, unknown>>): LedVf {
  if (isLedVf(params.vf)) return { ...params.vf };
  const color = typeof params.color === "string" ? params.color : "red";
  return Object.hasOwn(LED_VF_TABLE, color) ? LED_VF_TABLE[color as LedColor] : DEFAULT_LED_VF;
}


/**
 * Simulation light model shared by the simulator, the test author, and fixtures:
 * relative light level 0 (dark) … 1 (bright) maps log-linearly between 1 MΩ and 2 kΩ.
 */
export const PHOTORESISTOR_SIM = { darkOhms: 1_000_000, brightOhms: 2_000 } as const;

export function photoresistorOhms(level: number): number {
  const l = Math.min(1, Math.max(0, level));
  return Math.exp((1 - l) * Math.log(PHOTORESISTOR_SIM.darkOhms) + l * Math.log(PHOTORESISTOR_SIM.brightOhms));
}

const BAND_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"] as const;
export type BandColor = (typeof BAND_COLORS)[number] | "gold" | "silver";

/** 4-band color code for a resistor value (two digits + multiplier + tolerance). */
export function resistorBands(ohms: number, tolerancePct = 5): BandColor[] {
  if (!(ohms >= 1)) throw new Error(`resistor value out of range: ${ohms}`);
  let exponent = Math.floor(Math.log10(ohms)) - 1;
  let digits = Math.round(ohms / 10 ** exponent);
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exponent += 1;
  }
  const multiplier: BandColor = exponent === -1 ? "gold" : exponent === -2 ? "silver" : BAND_COLORS[exponent]!;
  const tolerance: BandColor = tolerancePct <= 1 ? "brown" : tolerancePct <= 2 ? "red" : tolerancePct <= 5 ? "gold" : "silver";
  return [BAND_COLORS[Math.floor(digits / 10)]!, BAND_COLORS[digits % 10]!, multiplier, tolerance];
}

/** "220 Ω", "10 kΩ", "1 MΩ". */
export function formatOhms(ohms: number): string {
  const [div, unit] = ohms >= 1e6 ? [1e6, "MΩ"] : ohms >= 1e3 ? [1e3, "kΩ"] : [1, "Ω"];
  return `${Number((ohms / div).toPrecision(3))} ${unit}`;
}
