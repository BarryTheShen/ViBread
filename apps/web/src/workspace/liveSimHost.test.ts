import type { Circuit } from "@vibread/core";
import { compileSketch } from "@vibread/firmware";
import { GOLDEN } from "@vibread/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { TICK_MS, createLiveSimHost } from "./liveSimHost.js";
import type { LiveSimOutput } from "./liveSimProtocol.js";

// Issue #29's mission: BTN1 → D2, BTN2 → D3, POT1 wiper → A0, passive buzzer on D9, tone() called on every loop() pass
// while a key is held (the pattern the TCCRnB prescaler fix makes audible).
const source = `void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP); pinMode(9, OUTPUT); Serial.begin(115200); Serial.println("ready"); }
void loop() {
  int hz = map(analogRead(A0), 0, 1023, 200, 2000);
  if (digitalRead(2) == LOW) tone(9, hz);
  else if (digitalRead(3) == LOW) tone(9, hz / 2);
  else noTone(9);
}
`;
const board = (pin: string) => ({ part: "board", pin });
const circuit: Circuit = {
  ...GOLDEN.find((design) => design.key === "knob-night-light")!.circuit,
  title: "Two-key knob piano",
  parts: [
    { id: "BTN1", module: "button", params: {} },
    { id: "BTN2", module: "button", params: {} },
    { id: "POT1", module: "potentiometer", params: { ohms: 10_000 } },
    { id: "R1", module: "resistor", params: { ohms: 220, tolerancePct: 5 } },
    { id: "BZ1", module: "buzzer-passive", params: {} },
  ],
  nets: [
    { id: "5V", kind: "power", pins: [board("5V"), { part: "POT1", pin: "B" }] },
    { id: "GND", kind: "ground", pins: [board("GND"), { part: "POT1", pin: "A" }, { part: "BTN1", pin: "3" }, { part: "BTN2", pin: "3" }, { part: "BZ1", pin: "N" }] },
    { id: "A0", kind: "signal", pins: [board("A0"), { part: "POT1", pin: "W" }] },
    { id: "D2", kind: "signal", pins: [board("D2"), { part: "BTN1", pin: "1" }] },
    { id: "D3", kind: "signal", pins: [board("D3"), { part: "BTN2", pin: "1" }] },
    { id: "D9", kind: "signal", pins: [board("D9"), { part: "R1", pin: "1" }] },
    { id: "BZP", kind: "signal", pins: [{ part: "R1", pin: "2" }, { part: "BZ1", pin: "P" }] },
  ],
  roles: [
    { pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "low key" },
    { pin: "D3", mode: "INPUT_PULLUP", part: "BTN2", purpose: "high key" },
    { pin: "A0", mode: "ANALOG_IN", part: "POT1", purpose: "pitch knob" },
    { pin: "D9", mode: "OUTPUT", part: "BZ1", purpose: "tone" },
  ],
  sketch: { source },
};

let hex = "";

/** The worker's host on a manual clock: `advance` moves wall time in TICK_MS steps, firing the tick like setInterval. */
function harness() {
  const posted: LiveSimOutput[] = [];
  let now = 0;
  let tick: (() => void) | undefined;
  const host = createLiveSimHost((message) => posted.push(message), {
    now: () => now,
    every: (_ms, fn) => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
  });
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      now += TICK_MS;
      tick?.();
    }
  };
  const lastState = () => {
    const state = posted.findLast((message) => message.type === "state");
    if (!state) throw new Error("no state frame posted");
    return state;
  };
  return { host, posted, advance, lastState };
}

describe("Try it worker host", () => {
  beforeAll(async () => {
    const compiled = await compileSketch({ source, board: circuit.board.profile });
    if (!compiled.ok || !compiled.hex) throw new Error(`piano sketch compile failed: ${compiled.log}`);
    hex = compiled.hex;
  }, 120_000);

  it("runs the two-key knob piano: a key sounds the knob's pitch, the other key half of it, release is silent", () => {
    const { host, posted, advance, lastState } = harness();
    host.handle({ type: "start", circuit, hex, light: {}, analog: { POT1: 0.5 } });
    expect(posted[0]).toEqual({ type: "started" });
    advance(300);
    expect(posted.some((message) => message.type === "error")).toBe(false);
    expect(posted.filter((m) => m.type === "serial").map((m) => (m.type === "serial" ? m.text : "")).join("")).toContain("ready");
    expect(lastState().timeMs).toBeGreaterThanOrEqual(280);
    expect(lastState().tones.BZ1).toBe(0);

    host.handle({ type: "digital", part: "BTN1", value: true });
    advance(200);
    expect(lastState().parts.BTN1).toBe(1);
    // map(512, 0, 1023, 200, 2000) ≈ 1100 Hz; timer 2's prescaler rounds the period by well under 3 %.
    expect(Math.abs(lastState().tones.BZ1! - 1100)).toBeLessThan(33);

    host.handle({ type: "analog", part: "POT1", value: 1 });
    advance(200);
    expect(Math.abs(lastState().tones.BZ1! - 2000)).toBeLessThan(60);

    host.handle({ type: "digital", part: "BTN1", value: false });
    host.handle({ type: "digital", part: "BTN2", value: true });
    advance(200);
    expect(Math.abs(lastState().tones.BZ1! - 1000)).toBeLessThan(30);

    host.handle({ type: "digital", part: "BTN2", value: false });
    advance(200);
    expect(lastState().tones.BZ1).toBe(0);
    expect(posted.some((message) => message.type === "error")).toBe(false);

    host.handle({ type: "stop" });
    const count = posted.length;
    advance(200);
    expect(posted.length).toBe(count);
  });

  it("reports a HEX it can't load as an error message with its stack instead of throwing out of the worker", () => {
    const { host, posted } = harness();
    expect(() => host.handle({ type: "start", circuit, hex: "not a hex file", light: {}, analog: {} })).not.toThrow();
    const error = posted.find((message) => message.type === "error");
    expect(error?.type === "error" && error.message.length > 0 && typeof error.stack === "string").toBe(true);
    expect(posted.some((message) => message.type === "started")).toBe(false);
  });
});
