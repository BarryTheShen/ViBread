import { z } from "zod";

/**
 * Bench telemetry protocol `vibread.telemetry/1` — newline-delimited JSON over USB serial at 115200 baud 8N1.
 *
 * Device side (bench firmware generated from a SelfTestPlan by @vibread/firmware):
 *  - Boot: every pin INPUT without pull-up (safe idle), then `hello`. `hello` repeats every 2 s until the first command.
 *  - `{c:"run",test:"all"}` runs `plan.tests` in order; `{c:"run",test:<id>}` runs one test. Each test is `begin` … `end`.
 *    After "all", `done`.
 *  - Read before drive — `pins.readonly` runs first and gates everything that drives a pin:
 *      1. passive reads: for every subject pin, `samples` reads without pull-up then with pull-up → two `read` lines.
 *      2. readback probe: for each output subject not already stuck, drive it to its active level for ≤ 4 µs with
 *         interrupts off, read PINx back, return to INPUT → one `probe` line. A readback that disagrees with the drive
 *         means a hard short to the other rail → `stuck` line.
 *    A pin that is stuck is never driven again in this run; tests that need it report `end` with status "fail" and
 *    note "stuck".
 *  - LEDs are only ever pulsed: ≤ 5 ms on, duty ≤ 10 % (SELFTEST_LIMITS), never held on.
 *  - Human steps: `ask` → the host renders the prompt from `kind` + the subject's label and answers with
 *    `{c:"answer",id,v}` (v = one of `choices`, or "done" / "timeout"). The device waits up to `timeoutMs`.
 *  - `obs` carries observations for the host evaluator; `end.status` is the device's local view, the host's
 *    evaluation in @vibread/bench is authoritative.
 */
export const TELEMETRY_PROTO = 1 as const;
export const TELEMETRY_BAUD = 115_200 as const;

export const TEST_IDS = [
  "rails.vcc",
  "pins.readonly",
  "digital.stuck",
  "button.interactive",
  "light.relative",
  "pot.sweep",
  "led.sequence",
  "buzzer.confirm",
  "net.continuity",
] as const;
export type TestId = (typeof TEST_IDS)[number];

/** What the host should ask the person to do; the host words it using the subject's label. */
export const ASK_KINDS = ["press-hold", "release", "cover", "uncover", "knob-min", "knob-max", "which-led", "heard-beep", "confirm"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

const bit = z.union([z.literal(0), z.literal(1)]);
const testId = z.enum(TEST_IDS);

export const DeviceLineSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), fw: z.enum(["vibread-bench", "vibread-app"]), proto: z.number().int(), design: z.string(), board: z.string() }),
  z.object({ t: z.literal("vcc"), mv: z.number().int() }),
  z.object({ t: z.literal("begin"), test: testId }),
  /** `ones` of `n` samples read HIGH. */
  z.object({ t: z.literal("read"), pin: z.string(), pull: bit, ones: z.number().int(), n: z.number().int() }),
  z.object({ t: z.literal("probe"), pin: z.string(), drive: bit, readback: bit }),
  /** Raw 10-bit ADC statistics over `n` samples; `phase` names the moment ("ambient", "covered", "min", "max"). */
  z.object({ t: z.literal("adc"), pin: z.string(), phase: z.string(), med: z.number(), min: z.number(), max: z.number(), n: z.number().int() }),
  z.object({ t: z.literal("ask"), id: z.string(), test: testId, kind: z.enum(ASK_KINDS), part: z.string().optional(), choices: z.array(z.string()), timeoutMs: z.number().int() }),
  z.object({ t: z.literal("obs"), test: testId, part: z.string().optional(), key: z.string(), v: z.union([z.number(), z.string(), z.boolean()]) }),
  z.object({ t: z.literal("stuck"), pin: z.string(), level: bit }),
  z.object({ t: z.literal("end"), test: testId, status: z.enum(["pass", "fail", "unknown", "skipped"]), note: z.string().optional() }),
  z.object({ t: z.literal("done") }),
  z.object({ t: z.literal("log"), msg: z.string() }),
  z.object({ t: z.literal("err"), msg: z.string() }),
]);
export type DeviceLine = z.infer<typeof DeviceLineSchema>;

export const HostCommandSchema = z.discriminatedUnion("c", [
  z.object({ c: z.literal("hello") }),
  z.object({ c: z.literal("run"), test: z.union([testId, z.literal("all")]) }),
  z.object({ c: z.literal("answer"), id: z.string(), v: z.string() }),
  z.object({ c: z.literal("abort") }),
]);
export type HostCommand = z.infer<typeof HostCommandSchema>;

export type DecodedLine = DeviceLine | { t: "invalid"; raw: string };

/** Parses one serial line; boot noise and partial lines come back as `invalid` rather than throwing. */
export function decodeDeviceLine(line: string): DecodedLine {
  const raw = line.trim();
  try {
    const parsed = DeviceLineSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { t: "invalid", raw };
  } catch {
    return { t: "invalid", raw };
  }
}

export function encodeHostCommand(cmd: HostCommand): string {
  return `${JSON.stringify(HostCommandSchema.parse(cmd))}\n`;
}
