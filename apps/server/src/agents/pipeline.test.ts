import { GOLDEN } from "@vibread/fixtures";
import type { Actor, Circuit } from "@vibread/core";
import { createPipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { memoryStore } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const AUTHOR: Actor = { kind: "agent", id: "design-agent", channel: "web" };

async function evaluate(circuit: Circuit, withSuite = true) {
  const store = memoryStore();
  const mission = await store.createMission({ title: "t", brief: golden.brief, ownerId: "o", inventory: golden.inventory, mode: "review" });
  await store.createRevision(mission.id, { circuit, ...(withSuite ? { suite: golden.suite } : {}), author: AUTHOR });
  const results = await createPipeline({ store }).evaluate(mission.id, 1);
  return { store, mission, results, byConsole: Object.fromEntries(results.reports.map((r) => [r.console, r])) };
}

describe("pipeline", () => {
  it("evaluates the golden Moon-Phase Lamp with the real engines and stores every artifact", async () => {
    const { store, mission, results, byConsole } = await evaluate(golden.circuit);
    expect(byConsole.EECOM!.verdict).toBe("GO");
    expect(byConsole.GUIDO!.verdict).toBe("GO");
    expect(byConsole.FIDO!.verdict).toBe("GO");
    expect(byConsole.FAO!.verdict).toBe("GO");
    expect(results.compile?.ok).toBe(true);
    expect(results.compile).not.toHaveProperty("hex");
    expect(results.sim).not.toHaveProperty("traces");
    for (const scenario of golden.suite.scenarios) expect(results.artifacts[`trace-${scenario.id}.json`]).toBeDefined();
    expect(results.sim?.scenarios.map((s) => s.traceKey)).toEqual(golden.suite.scenarios.map((s) => `trace-${s.id}.json`));
    for (const key of ["app.hex", "bench.hex", "schematic.svg", "breadboard.svg"]) expect(results.artifacts[key], key).toBeDefined();
    expect(results.selftest?.subjects.length).toBeGreaterThan(0);
    expect(results.steps?.steps.length).toBeGreaterThan(0);
    for (const step of results.steps!.steps) {
      const png = await store.getArtifact(results.artifacts[`step-${step.n}.png`]!);
      expect(png?.contentType).toBe("image/png");
    }
    const hex = await store.getArtifact(results.artifacts["app.hex"]!);
    expect(new TextDecoder().decode(hex!.data)).toMatch(/^:[0-9A-F]{10}/);
    const events = await store.listEvents(mission.id);
    expect(events.filter((e) => e.kind === "console.report").map((e) => (e.data as { console: string }).console)).toEqual(["EECOM", "GUIDO", "FIDO", "FAO"]);
  }, 120_000);

  it("isolates a sketch that does not compile: firmware NO-GO, simulation skipped, electrical checks unaffected", async () => {
    const broken: Circuit = { ...golden.circuit, sketch: { source: golden.circuit.sketch.source.replace("void loop() {", "void loop() { this is not C++;") } };
    const { results, byConsole } = await evaluate(broken);
    expect(byConsole.EECOM!.verdict).toBe("GO");
    expect(byConsole.GUIDO!.verdict).toBe("NO-GO");
    expect(byConsole.FIDO!.verdict).toBe("SKIPPED");
    expect(results.compile?.ok).toBe(false);
    expect(results.artifacts["app.hex"]).toBeUndefined();
  }, 60_000);

  it("reports a structurally invalid design on EECOM and skips the rest", async () => {
    const invalid: Circuit = { ...golden.circuit, parts: [...golden.circuit.parts, golden.circuit.parts[0]!] };
    const { byConsole } = await evaluate(invalid, false);
    expect(byConsole.EECOM!.verdict).toBe("NO-GO");
    expect(byConsole.EECOM!.findings.some((f) => f.ruleId === "IR-DUP-PART")).toBe(true);
    expect([byConsole.GUIDO!.verdict, byConsole.FIDO!.verdict, byConsole.FAO!.verdict]).toEqual(["SKIPPED", "SKIPPED", "SKIPPED"]);
  });

  it("marks simulation PENDING when no independent suite exists yet", async () => {
    const { byConsole } = await evaluate(golden.circuit, false);
    expect(byConsole.FIDO!.verdict).toBe("PENDING");
    expect(byConsole.GUIDO!.verdict).toBe("GO");
  }, 60_000);
});
