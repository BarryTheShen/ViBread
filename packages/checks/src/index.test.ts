import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { CIRCUIT_SCHEMA, revisionHash, type BoardProfileId, type Circuit, type CompileResult, type ConsoleReport, type PinRef } from "@vibread/core";
import { runElectricalChecks, runFirmwareChecks, spiceCrossCheck } from "./index.js";

const b = (pin: string): PinRef => ({ part: "board", pin });
const p = (part: string, pin: string): PinRef => ({ part, pin });

function bench(parts: Circuit["parts"], nets: Circuit["nets"], roles: Circuit["roles"], profile: BoardProfileId = "uno-r3-atmega328p-5v"): Circuit {
  return { schema: CIRCUIT_SCHEMA, title: "t", summary: "t", board: { profile }, breadboard: { profile: "bb-830" }, parts, nets, roles, sketch: { source: "" }, intent: [], assumptions: [] } as Circuit;
}

/** One LED on `pin` through a resistor to GND. */
function ledCircuit(color: string, ohms: number | undefined, pin = "D3"): Circuit {
  const parts: Circuit["parts"] = [{ id: "LED1", module: "led", label: "light", params: { color } }];
  const nets: Circuit["nets"] = [{ id: "GND", kind: "ground", pins: [b("GND"), p("LED1", "K")] }];
  if (ohms === undefined) {
    nets.push({ id: pin, kind: "signal", pins: [b(pin), p("LED1", "A")] });
  } else {
    parts.push({ id: "R1", module: "resistor", label: "resistor", params: { ohms, tolerancePct: 5 } });
    nets.push({ id: pin, kind: "signal", pins: [b(pin), p("R1", "1")] }, { id: "L1", kind: "signal", pins: [p("R1", "2"), p("LED1", "A")] });
  }
  return bench(parts, nets, [{ pin, mode: "OUTPUT", part: "LED1", purpose: "light" }]);
}

/** `count` red LEDs, each through `ohms` to GND, fed from D2.. pins (or all from the 5 V header). */
function ledBank(count: number, ohms: number, feed: "pins" | "5V"): Circuit {
  const pins = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"].slice(0, count);
  const parts: Circuit["parts"] = pins.flatMap((_, i) => [
    { id: `LED${i}`, module: "led" as const, label: "light", params: { color: "red" } },
    { id: `R${i}`, module: "resistor" as const, label: "resistor", params: { ohms, tolerancePct: 5 } },
  ]);
  const nets: Circuit["nets"] = [
    ...pins.map((_, i) => ({ id: `L${i}`, kind: "signal" as const, pins: [p(`R${i}`, "2"), p(`LED${i}`, "A")] })),
    { id: "GND", kind: "ground", pins: [b("GND"), ...pins.map((_, i) => p(`LED${i}`, "K"))] },
  ];
  if (feed === "5V") {
    nets.push({ id: "5V", kind: "power", pins: [b("5V"), ...pins.map((_, i) => p(`R${i}`, "1"))] });
    return bench(parts, nets, []);
  }
  nets.push(...pins.map((pin, i) => ({ id: pin, kind: "signal" as const, pins: [b(pin), p(`R${i}`, "1")] })));
  return bench(parts, nets, pins.map((pin, i) => ({ pin, mode: "OUTPUT" as const, part: `LED${i}`, purpose: "light" })));
}

function buzzerCircuit(module: "buzzer-active" | "buzzer-passive", pin: string, ohms?: number): Circuit {
  const parts: Circuit["parts"] = [{ id: "BZ1", module, label: "buzzer", params: {} }];
  const nets: Circuit["nets"] = [{ id: "GND", kind: "ground", pins: [b("GND"), p("BZ1", "N")] }];
  if (ohms === undefined) {
    nets.push({ id: pin, kind: "signal", pins: [b(pin), p("BZ1", "P")] });
  } else {
    parts.push({ id: "R1", module: "resistor", label: "resistor", params: { ohms, tolerancePct: 5 } });
    nets.push({ id: pin, kind: "signal", pins: [b(pin), p("R1", "1")] }, { id: "M", kind: "signal", pins: [p("R1", "2"), p("BZ1", "P")] });
  }
  return bench(parts, nets, [{ pin, mode: "OUTPUT", part: "BZ1", purpose: "beep" }]);
}

function potCircuit(wiperPin: string, mode: Circuit["roles"][number]["mode"], profile?: BoardProfileId): Circuit {
  return bench(
    [{ id: "POT1", module: "potentiometer", label: "knob", params: { ohms: 10_000 } }],
    [
      { id: "5V", kind: "power", pins: [b("5V"), p("POT1", "A")] },
      { id: "W", kind: "signal", pins: [b(wiperPin), p("POT1", "W")] },
      { id: "GND", kind: "ground", pins: [b("GND"), p("POT1", "B")] },
    ],
    [{ pin: wiperPin, mode, part: "POT1", purpose: "knob" }],
    profile,
  );
}

function buttonCircuit(pin: string, mode: Circuit["roles"][number]["mode"], profile?: BoardProfileId): Circuit {
  return bench(
    [{ id: "BTN1", module: "button", label: "button", params: {} }],
    [{ id: pin, kind: "signal", pins: [b(pin), p("BTN1", "1")] }, { id: "GND", kind: "ground", pins: [b("GND"), p("BTN1", "3")] }],
    [{ pin, mode, part: "BTN1", purpose: "press" }],
    profile,
  );
}

function ids(report: { findings: { ruleId: string }[] }): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

function reportFor(circuit: Circuit) {
  return runElectricalChecks(circuit, revisionHash(circuit));
}

describe("EECOM electrical checks", () => {
  it("catches the five broken design variants with one primary rule each", async () => {
    const base = GOLDEN[0].circuit;

    const noResistor = structuredClone(base);
    noResistor.parts = noResistor.parts.filter((part) => part.id !== "R1");
    noResistor.nets = noResistor.nets
      .filter((net) => net.id !== "L1")
      .map((net) => net.id === "D3" ? { ...net, pins: [{ part: "board", pin: "D3" }, { part: "LED1", pin: "A" }] } : net);

    const floatingButton = structuredClone(base);
    floatingButton.roles = floatingButton.roles.map((role) => role.pin === "D2" ? { ...role, mode: "INPUT" as const } : role);

    const outputConflict = structuredClone(base);
    outputConflict.nets = outputConflict.nets.map((net) => net.id === "D3" ? { ...net, pins: [...net.pins, { part: "board", pin: "D7" }] } : net);
    outputConflict.roles = [...outputConflict.roles, { pin: "D7", mode: "OUTPUT", part: "LED1", purpose: "conflicting output" }];

    const short = structuredClone(base);
    short.nets = short.nets.map((net) => net.id === "5V" ? { ...net, pins: [...net.pins, { part: "board", pin: "GND" }] } : net);

    const nonPwm = structuredClone(GOLDEN[1].circuit);
    nonPwm.roles = nonPwm.roles.map((role) => role.pin === "D9" ? { ...role, pin: "D8" } : role);

    await expect(reportFor(noResistor)).resolves.toMatchObject({ verdict: "NO-GO", findings: [{ ruleId: "LED-RESISTOR" }] });
    await expect(reportFor(floatingButton)).resolves.toMatchObject({ verdict: "NO-GO", findings: [{ ruleId: "BTN-PULLUP" }] });
    await expect(reportFor(outputConflict)).resolves.toMatchObject({ verdict: "NO-GO", findings: [{ ruleId: "OUT-OUT-CONFLICT" }] });
    await expect(reportFor(short)).resolves.toMatchObject({ verdict: "NO-GO", findings: [{ ruleId: "SHORT-GRAPH" }] });
    await expect(reportFor(nonPwm)).resolves.toMatchObject({ verdict: "NO-GO", findings: [{ ruleId: "PWM-PINS" }] });

    expect(ids(await reportFor(noResistor))).toEqual(["LED-RESISTOR"]);
    expect(ids(await reportFor(floatingButton))).toEqual(["BTN-PULLUP"]);
    expect(ids(await reportFor(outputConflict))).toEqual(["OUT-OUT-CONFLICT"]);
    expect(ids(await reportFor(short))).toEqual(["SHORT-GRAPH"]);
    expect(ids(await reportFor(nonPwm))).toEqual(["PWM-PINS"]);
  });

  it("keeps the golden designs GO and reports the conservative LED corner", async () => {
    const reports = await Promise.all(GOLDEN.map((golden) => reportFor(golden.circuit)));
    expect(reports.map((report) => report.verdict)).toEqual(["GO", "GO", "GO"]);
    expect(reports[2].findings.map((finding) => finding.ruleId)).toEqual(["CUR-PIN-DESIGN"]);
    const launchEvidence = reports[2].evidence as { ledBranches: { part: string; maxMa: number }[] };
    const red = launchEvidence.ledBranches.find((branch) => branch.part === "LED1");
    expect(red?.maxMa).toBeCloseTo((5.25 - 1.8) / (220 * 0.95) * 1_000, 2);
  });
  it("accepts custom LED Vf data and explains the conservative fallback", async () => {
    const custom = structuredClone(GOLDEN[2].circuit);
    const customLed = custom.parts.find((part) => part.id === "LED1");
    if (!customLed) throw new Error("fixture LED1 missing");
    customLed.params = { color: "infrared", vf: { min: 1.6, typ: 1.9, max: 2.2 } };
    const customReport = await reportFor(custom);
    expect(customReport.verdict).toBe("GO");
    expect(customReport.findings.some((finding) => finding.ruleId === "LED-VF-ASSUMED")).toBe(false);

    const assumed = structuredClone(GOLDEN[2].circuit);
    const assumedLed = assumed.parts.find((part) => part.id === "LED1");
    if (!assumedLed) throw new Error("fixture LED1 missing");
    assumedLed.params = { color: "infrared" };
    const assumedReport = await reportFor(assumed);
    expect(assumedReport.verdict).toBe("GO");
    expect(assumedReport.findings.some((finding) => finding.ruleId === "LED-VF-ASSUMED")).toBe(true);
  });
});

describe("EECOM on adversarial beginner circuits", () => {
  const fixOf = (report: ConsoleReport, ruleId: string) => report.findings.find((finding) => finding.ruleId === ruleId)?.fix;

  it("blocks a bare LED and names the resistor and where it goes", async () => {
    const report = await reportFor(ledCircuit("red", undefined));
    expect(report.verdict).toBe("NO-GO");
    expect(fixOf(report, "LED-RESISTOR")).toBe("Put a 220 Ω resistor between D3 and LED1's long leg (anode).");
  });

  it("blocks a red LED on 100 Ω (over the LED's 30 mA maximum) and asks for 220 Ω", async () => {
    const report = await reportFor(ledCircuit("red", 100));
    expect(report.verdict).toBe("NO-GO");
    expect(ids(report)).toContain("LED-CURRENT");
    expect(fixOf(report, "LED-CURRENT")).toBe("Change R1 (100 Ω) to 220 Ω or more for LED1.");
    expect(ids(await reportFor(ledCircuit("red", 220)))).toEqual([]);
  });

  it("only warns for a blue LED on 100 Ω (under 30 mA) and names the next safe value", async () => {
    const report = await reportFor(ledCircuit("blue", 100));
    expect(report.verdict).toBe("GO");
    expect(ids(report)).toEqual(["CUR-PIN-DESIGN"]);
    expect(fixOf(report, "CUR-PIN-DESIGN")).toBe("Change R1 (100 Ω) to 150 Ω or more for LED1.");
  });

  it("accepts a bare button to GND when the sketch uses INPUT_PULLUP, but not on the Nano's pull-up-less A6", async () => {
    expect((await reportFor(buttonCircuit("D2", "INPUT_PULLUP"))).verdict).toBe("GO");
    const floating = await reportFor(buttonCircuit("D2", "INPUT"));
    expect(fixOf(floating, "BTN-PULLUP")).toContain("pinMode(2, INPUT_PULLUP)");
    const a6 = await reportFor(buttonCircuit("A6", "INPUT_PULLUP", "nano-atmega328p-5v"));
    expect(a6.verdict).toBe("NO-GO");
    expect(fixOf(a6, "BTN-PULLUP")).toBe("Move BTN1 from A6 to D2 and use INPUT_PULLUP, or add a 10 kΩ resistor from A6 to 5 V.");
  });

  it("warns about a buzzer on D0 and names a free pin to move it to", async () => {
    const report = await reportFor(buzzerCircuit("buzzer-active", "D0"));
    expect(fixOf(report, "SERIAL-USB")).toBe("Move BZ1 from D0 to D2; D0/D1 carry uploads and USB serial.");
  });

  it("keeps the passive-buzzer minimum consistent with the 40 mA pin limit", async () => {
    const tooSmall = await reportFor(buzzerCircuit("buzzer-passive", "D8", 100));
    expect(ids(tooSmall)).toEqual(expect.arrayContaining(["BUZZER-SERIES-R", "CUR-PIN-ABS"]));
    expect(fixOf(tooSmall, "BUZZER-SERIES-R")).toBe("Put a 270 Ω resistor between D8 and BZ1's + leg (at least 150 Ω).");
    // The stated minimum must itself pass: 5.25 V / (16 Ω + 142.5 Ω) ≈ 33 mA.
    const atMinimum = await reportFor(buzzerCircuit("buzzer-passive", "D8", 150));
    expect(atMinimum.verdict).toBe("GO");
    expect(ids(await reportFor(buzzerCircuit("buzzer-passive", "D8", 270)))).toEqual([]);
  });

  it("blocks a knob wiper read on a digital-only pin and points it to an analog pin", async () => {
    const report = await reportFor(potCircuit("D7", "INPUT"));
    expect(report.verdict).toBe("NO-GO");
    expect(fixOf(report, "POT-ANALOG-PIN")).toBe("Move POT1's middle leg to A0, give A0 an ANALOG_IN role, and read it with analogRead(A0).");
    expect(ids(await reportFor(potCircuit("A0", "ANALOG_IN")))).toEqual([]);
    expect(ids(await reportFor(potCircuit("A6", "ANALOG_IN", "nano-atmega328p-5v")))).toEqual([]);
  });

  it("allows 10 LEDs at 15 mA from pins, blocks 12, and does not charge 5 V-header LEDs to the chip", async () => {
    // 200 Ω red: (5 − 2.0) / 200 = 15 mA typical, 18.2 mA at the conservative corner.
    expect((await reportFor(ledBank(10, 200, "pins"))).verdict).toBe("GO");
    const twelve = await reportFor(ledBank(12, 200, "pins"));
    expect(ids(twelve)).toEqual(["CUR-VCC-GND"]);
    expect(fixOf(twelve, "CUR-VCC-GND")).toContain("use 220 Ω or more");
    // The same 12 LEDs fed from the 5 V header never pass through the ATmega328P's VCC/GND pins.
    expect(ids(await reportFor(ledBank(12, 200, "5V")))).toEqual([]);
  });
});

describe("GUIDO firmware checks", () => {
  it("flags a mode mismatch and a sketch output with no circuit role", () => {
    const circuit = GOLDEN[0].circuit;
    const compile: CompileResult = { ok: true, fqbn: "arduino:avr:uno", diagnostics: [], durationMs: 1, log: "" };
    const report = runFirmwareChecks({
      circuit,
      compile,
      pinModes: [
        { pin: "D2", mode: "OUTPUT", toggled: true },
        { pin: "D99", mode: "OUTPUT", toggled: true },
      ],
      revisionHash: revisionHash(circuit),
    });
    expect(report.verdict).toBe("NO-GO");
    expect(ids(report)).toEqual(expect.arrayContaining(["PIN-MODE-MISMATCH", "PIN-UNDECLARED-OUTPUT"]));
  });
  it("accepts a PWM_OUT role driven as a plain output (Servo library, analogWrite 0/255)", () => {
    const circuit = GOLDEN[1].circuit;
    const pwm = circuit.roles.find((role) => role.mode === "PWM_OUT")!;
    const compile: CompileResult = { ok: true, fqbn: "arduino:avr:uno", diagnostics: [], durationMs: 1, log: "" };
    const report = runFirmwareChecks({ circuit, compile, pinModes: [{ pin: pwm.pin, mode: "OUTPUT", toggled: true }], revisionHash: revisionHash(circuit) });
    expect(ids(report)).not.toContain("PIN-MODE-MISMATCH");
    const input = runFirmwareChecks({ circuit, compile, pinModes: [{ pin: pwm.pin, mode: "INPUT", toggled: false }], revisionHash: revisionHash(circuit) });
    expect(input.findings.find((finding) => finding.ruleId === "PIN-MODE-MISMATCH")?.fix).toBe(`Call pinMode(${pwm.pin.slice(1)}, OUTPUT) in setup() instead of INPUT, or change the circuit role to INPUT.`);
  });
  it("surfaces sketch warnings but only counts core warnings in evidence", () => {
    const circuit = GOLDEN[0].circuit;
    const compile: CompileResult = {
      ok: true,
      fqbn: "arduino:avr:uno",
      diagnostics: [
        { severity: "warning", file: "/tmp/cores/arduino/new.cpp", message: "unused parameter 'tag'" },
        { severity: "warning", file: "/tmp/build/sketch/sketch.ino", message: "comparison is always true" },
      ],
      durationMs: 1,
      log: "",
    };
    const report = runFirmwareChecks({
      circuit,
      compile,
      pinModes: circuit.roles.map((role) => ({ pin: role.pin, mode: role.mode, toggled: false })),
      revisionHash: revisionHash(circuit),
    });
    const warningFindings = report.findings.filter((finding) => finding.ruleId === "FW-WARNING");
    expect(warningFindings).toHaveLength(1);
    expect(warningFindings[0]?.detail).toContain("comparison is always true");
    expect(warningFindings[0]?.detail).not.toContain("unused parameter");
    expect(report.evidence).toMatchObject({ compilerWarnings: { sketchWarnings: 1, otherWarnings: 1 } });
  });
});

describe("SPICE cross-check", () => {
  it("uses fixed red models at all corners and catches a wrong Vf assumption", async () => {
    const result = await spiceCrossCheck(GOLDEN[2].circuit);
    const red = result.rows.find((row) => row.part === "LED1");
    expect(result.ok).toBe(true);
    expect(red?.analyticMa).toBeCloseTo(13.636, 2);
    expect(red?.spiceMa).toBeCloseTo(14.0, 1);
    expect(red?.spiceMaxMa).toBeCloseTo(16.7, 1);
    expect(red?.spiceMinMa).toBeCloseTo(9.7, 1);
    const otherGoldenResults = await Promise.all([spiceCrossCheck(GOLDEN[0].circuit), spiceCrossCheck(GOLDEN[1].circuit)]);
    expect([...otherGoldenResults, result].flatMap((crossCheck) => crossCheck.findings.filter((finding) => finding.ruleId === "SPICE-DEVIATION"))).toEqual([]);
    expect(result.findings.every((finding) => finding.ruleId !== "SPICE-DEVIATION" || finding.refs?.parts?.[0] !== "LED1")).toBe(true);

    const wrong = await spiceCrossCheck(GOLDEN[2].circuit, { analyticVf: { red: 1.0 } });
    expect(wrong.findings.some((finding) => finding.ruleId === "SPICE-DEVIATION")).toBe(true);
  });
});
