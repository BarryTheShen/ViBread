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
  it("matches the audited red LED branch near 13.4 mA", async () => {
    const result = await spiceCrossCheck(GOLDEN[2].circuit);
    const red = result.rows.find((row) => row.part === "LED1");
    expect(result.ok).toBe(true);
    expect(red?.spiceMa).toBeCloseTo(13.4, 1);
    expect(result.findings).toEqual([]);
  });
});
