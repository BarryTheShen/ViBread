import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { revisionHash, type Circuit, type CompileResult } from "@vibread/core";
import { runElectricalChecks, runFirmwareChecks, spiceCrossCheck } from "./index.js";

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
