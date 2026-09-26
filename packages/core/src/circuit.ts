import { z } from "zod";
import { BOARD_PROFILE_IDS, BOARD_PROFILES, boardPin } from "./boards.js";
import { BREADBOARD_PROFILE_IDS } from "./breadboards.js";
import { ELECTRICAL_TYPES } from "./electrical.js";
import { hashJson } from "./hash.js";
import { MODULE_KEYS, MODULES, type ModulePin } from "./modules.js";
import type { TestSuite } from "./scenario.js";

export const CIRCUIT_SCHEMA = "vibread.circuit/0.1" as const;
/** `PinRef.part` value for Arduino board pins: { part: "board", pin: "D3" }. */
export const BOARD_PART = "board" as const;
/**
 * Supported-circuit envelope (PLAN §1). Parts/nets are what the breadboard allocator provably lays out LVS-clean:
 * seeded random designs at 20 parts / up to 20 signal nets fit the 830-point board every time (and ~99 % of the time
 * the 400-point one, which otherwise gets a tool-side LAYOUT-NO-FIT finding); the Uno has 18 usable I/O pins.
 */
export const ENVELOPE = { maxParts: 20, maxSignalNets: 20, maxExternalLoadMa: 400 } as const;

export const PinRefSchema = z.object({ part: z.string().min(1), pin: z.string().min(1) });
export type PinRef = z.infer<typeof PinRefSchema>;

export const ModulePinSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  etype: z.enum(ELECTRICAL_TYPES),
  polarity: z.enum(["+", "-"]).optional(),
});

export const PartSchema = z.object({
  /** Reference designator: LED1, R1, BTN1, LDR1, POT1, BZ1, U2 … */
  id: z.string().regex(/^[A-Z][A-Z0-9]{0,11}$/, "part ids are reference designators like LED1, R2, BTN1"),
  module: z.enum(MODULE_KEYS),
  /** Plain-language label shown to the builder ("Rightmost moon light"). */
  label: z.string().min(1).optional(),
  /** Validated against MODULES[module].params. */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Generic parts only: the user-supplied pinout. */
  pinout: z.array(ModulePinSchema).optional(),
});
export type Part = z.infer<typeof PartSchema>;

export const NetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_+-]{1,24}$/),
  kind: z.enum(["power", "ground", "signal"]),
  pins: z.array(PinRefSchema).min(2),
});
export type Net = z.infer<typeof NetSchema>;

export const PIN_MODES = ["OUTPUT", "INPUT", "INPUT_PULLUP", "ANALOG_IN", "PWM_OUT"] as const;
export type PinMode = (typeof PIN_MODES)[number];

/** What the sketch does with each board pin it uses. The code↔circuit check compares simulation against these. */
export const PinRoleSchema = z.object({
  pin: z.string().min(1),
  mode: z.enum(PIN_MODES),
  part: z.string().min(1),
  purpose: z.string().min(1),
});
export type PinRole = z.infer<typeof PinRoleSchema>;

export const IntentClauseSchema = z.object({ id: z.string().regex(/^C\d+$/), text: z.string().min(1) });
export type IntentClause = z.infer<typeof IntentClauseSchema>;

export const CircuitSchema = z.object({
  schema: z.literal(CIRCUIT_SCHEMA),
  title: z.string().min(1).max(80),
  summary: z.string().min(1),
  board: z.object({ profile: z.enum(BOARD_PROFILE_IDS) }),
  breadboard: z.object({ profile: z.enum(BREADBOARD_PROFILE_IDS) }),
  parts: z.array(PartSchema).min(1),
  nets: z.array(NetSchema).min(1),
  roles: z.array(PinRoleSchema),
  /**
   * Arduino sketch (.ino). Calibration convention: tunable constants are macros with guarded defaults,
   *   #ifndef VB_CAL_LDR1_DARK
   *   #define VB_CAL_LDR1_DARK 300
   *   #endif
   * and the firmware package prepends `#define VB_CAL_LDR1_DARK <measured>` before the final flash.
   */
  sketch: z.object({ source: z.string().min(1) }),
  intent: z.array(IntentClauseSchema).min(1),
  assumptions: z.array(z.string()).default([]),
});
export type Circuit = z.infer<typeof CircuitSchema>;

export interface IrIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
  refs?: { parts?: string[]; nets?: string[]; pins?: string[] };
}

/** "LED1.A", "board.D3" — the key used for pin→net indexes everywhere. */
export function pinKey(ref: PinRef): string {
  return `${ref.part}.${ref.pin}`;
}

export function modulePins(part: Part): ModulePin[] {
  return part.module === "generic" ? (part.pinout ?? []) : MODULES[part.module].pins;
}

/** Pin key → net id for every connected pin. */
export function netIndex(circuit: Circuit): Map<string, string> {
  const index = new Map<string, string>();
  for (const net of circuit.nets) for (const ref of net.pins) index.set(pinKey(ref), net.id);
  return index;
}

/** Revision hash: binds approvals, layouts, and firmware banners to one exact design + test suite. */
export function revisionHash(circuit: Circuit, suite?: TestSuite): string {
  return hashJson({ circuit, suite: suite ?? null });
}

/** Structural validation beyond the zod schema. Electrical rules live in @vibread/checks. */
export function validateCircuit(circuit: Circuit): IrIssue[] {
  const issues: IrIssue[] = [];
  const board = BOARD_PROFILES[circuit.board.profile];
  const parts = new Map<string, Part>();

  for (const part of circuit.parts) {
    if (parts.has(part.id)) issues.push({ code: "IR-DUP-PART", severity: "error", message: `Two parts are called ${part.id}.`, refs: { parts: [part.id] } });
    parts.set(part.id, part);
    const params = MODULES[part.module].params.safeParse(part.params);
    if (!params.success) {
      issues.push({ code: "IR-BAD-PARAMS", severity: "error", message: `${part.id} (${part.module}) has invalid params: ${params.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, refs: { parts: [part.id] } });
    }
    if (part.module === "generic" && !part.pinout?.length) issues.push({ code: "IR-GENERIC-PINOUT", severity: "error", message: `${part.id} is a generic part and needs a pinout.`, refs: { parts: [part.id] } });
    if (part.module !== "generic" && part.pinout) issues.push({ code: "IR-GENERIC-PINOUT", severity: "error", message: `${part.id} is a library part; only generic parts carry a pinout.`, refs: { parts: [part.id] } });
  }

  const seenNet = new Set<string>();
  const pinToNet = new Map<string, string>();
  for (const net of circuit.nets) {
    if (seenNet.has(net.id)) issues.push({ code: "IR-DUP-NET", severity: "error", message: `Two nets are called ${net.id}.`, refs: { nets: [net.id] } });
    seenNet.add(net.id);
    for (const ref of net.pins) {
      const key = pinKey(ref);
      if (ref.part === BOARD_PART) {
        const pin = boardPin(board, ref.pin);
        if (!pin) issues.push({ code: "IR-UNKNOWN-PIN", severity: "error", message: `${board.name} has no pin ${ref.pin}.`, refs: { nets: [net.id], pins: [key] } });
        else if ((pin.kind === "ground") !== (net.kind === "ground") || (pin.kind === "power" && net.kind !== "power")) {
          issues.push({ code: "IR-NET-KIND", severity: "error", message: `Net ${net.id} is marked ${net.kind} but contains board pin ${ref.pin}.`, refs: { nets: [net.id], pins: [key] } });
        }
      } else {
        const part = parts.get(ref.part);
        if (!part) issues.push({ code: "IR-UNKNOWN-PART", severity: "error", message: `Net ${net.id} refers to missing part ${ref.part}.`, refs: { nets: [net.id], parts: [ref.part] } });
        else if (!modulePins(part).some((p) => p.id === ref.pin)) {
          issues.push({ code: "IR-UNKNOWN-PIN", severity: "error", message: `${ref.part} (${part.module}) has no pin "${ref.pin}".`, refs: { nets: [net.id], pins: [key] } });
        }
      }
      const other = pinToNet.get(key);
      if (other && other !== net.id) issues.push({ code: "IR-PIN-MULTI-NET", severity: "error", message: `${key} is in two nets (${other}, ${net.id}); merge them into one net.`, refs: { nets: [other, net.id], pins: [key] } });
      else if (other === net.id) issues.push({ code: "IR-DUP-PIN", severity: "warning", message: `${key} is listed twice in ${net.id}.`, refs: { nets: [net.id], pins: [key] } });
      pinToNet.set(key, net.id);
    }
  }

  for (const part of parts.values()) {
    const groups = MODULES[part.module].internallyConnected ?? [];
    for (const pin of modulePins(part)) {
      const joined = groups.find((g) => g.includes(pin.id)) ?? [pin.id];
      if (!joined.some((id) => pinToNet.has(`${part.id}.${id}`))) {
        issues.push({ code: "IR-UNCONNECTED-PIN", severity: "warning", message: `${part.id} ${pin.name} is not connected to anything.`, refs: { parts: [part.id], pins: [`${part.id}.${pin.id}`] } });
      }
    }
  }

  const rolePins = new Set<string>();
  for (const role of circuit.roles) {
    const pin = boardPin(board, role.pin);
    if (!pin || (pin.kind !== "digital" && pin.kind !== "analog")) {
      issues.push({ code: "IR-ROLE-PIN", severity: "error", message: `Role for ${role.pin}: not an I/O pin on ${board.name}.`, refs: { pins: [`board.${role.pin}`] } });
      continue;
    }
    if (rolePins.has(role.pin)) issues.push({ code: "IR-ROLE-DUP", severity: "error", message: `${role.pin} has two roles.`, refs: { pins: [`board.${role.pin}`] } });
    rolePins.add(role.pin);
    if (role.mode === "ANALOG_IN" && pin.adc === undefined) issues.push({ code: "IR-ROLE-MODE", severity: "error", message: `${role.pin} cannot read analog values.`, refs: { pins: [`board.${role.pin}`] } });
    if (role.mode === "PWM_OUT" && !pin.pwm) issues.push({ code: "IR-ROLE-MODE", severity: "error", message: `${role.pin} has no PWM; use one of D3, D5, D6, D9, D10, D11.`, refs: { pins: [`board.${role.pin}`] } });
    if (role.mode !== "ANALOG_IN" && !pin.digital) issues.push({ code: "IR-ROLE-MODE", severity: "error", message: `${role.pin} is analog-input only.`, refs: { pins: [`board.${role.pin}`] } });
    if (!pinToNet.has(`board.${role.pin}`)) issues.push({ code: "IR-ROLE-UNWIRED", severity: "error", message: `${role.pin} has a role but no wire.`, refs: { pins: [`board.${role.pin}`] } });
    if (!parts.has(role.part)) issues.push({ code: "IR-UNKNOWN-PART", severity: "error", message: `Role for ${role.pin} names missing part ${role.part}.`, refs: { parts: [role.part] } });
    if (board.reserved.includes(role.pin)) issues.push({ code: "IR-RESERVED-PIN", severity: "warning", message: `${role.pin} is used by USB serial; uploads and the self-test may fail.`, refs: { pins: [`board.${role.pin}`] } });
  }

  const signalNets = circuit.nets.filter((n) => n.kind === "signal").length;
  if (circuit.parts.length > ENVELOPE.maxParts || signalNets > ENVELOPE.maxSignalNets) {
    issues.push({ code: "IR-ENVELOPE", severity: "error", message: `Outside the supported envelope: ${circuit.parts.length} parts (max ${ENVELOPE.maxParts}), ${signalNets} signal nets (max ${ENVELOPE.maxSignalNets}).` });
  }

  const clauseIds = new Set<string>();
  for (const clause of circuit.intent) {
    if (clauseIds.has(clause.id)) issues.push({ code: "IR-DUP-CLAUSE", severity: "error", message: `Intent clause ${clause.id} appears twice.` });
    clauseIds.add(clause.id);
  }
  return issues;
}

export type ParseCircuitResult = { ok: true; circuit: Circuit; issues: IrIssue[] } | { ok: false; issues: IrIssue[] };

/** zod parse + structural validation. `ok` is false on any error-severity issue. */
export function parseCircuit(input: unknown): ParseCircuitResult {
  const parsed = CircuitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ code: "IR-SCHEMA", severity: "error" as const, message: i.message, path: i.path.join(".") })),
    };
  }
  const issues = validateCircuit(parsed.data);
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };
  return { ok: true, circuit: parsed.data, issues };
}
