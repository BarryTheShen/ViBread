import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { renderSchematicSvg, schematicSummary } from "./index.js";

describe("schematic renderer", () => {
  it.each(GOLDEN)("draws every part and power symbol in $circuit.title", async (fixture) => {
    const started = performance.now();
    const svg = await renderSchematicSvg(fixture.circuit);
    const elapsedMs = performance.now() - started;
    const repeatStarted = performance.now();
    const repeat = await renderSchematicSvg(fixture.circuit);
    const repeatElapsedMs = performance.now() - repeatStarted;

    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('data-schematic="drawing"');
    for (const part of fixture.circuit.parts) expect(svg).toContain(`data-part="${part.id}"`);
    for (const net of fixture.circuit.nets.filter((candidate) => candidate.kind !== "signal")) {
      for (const ref of net.pins) expect(svg).toContain(`data-net="${net.id}" data-pin="${ref.part}.${ref.pin}"`);
    }
    expect(repeat).toBe(svg);
    if (fixture.circuit.title === "Moon-Phase Lamp") expect(repeatElapsedMs).toBeLessThan(elapsedMs);
  });

  it("is deterministic for identical input", async () => {
    for (const fixture of GOLDEN) {
      const first = await renderSchematicSvg(fixture.circuit);
      const second = await renderSchematicSvg(fixture.circuit);
      expect(second).toBe(first);
    }
  });

  it("provides a plain-language netlist fallback", () => {
    const summary = schematicSummary(GOLDEN[0].circuit);
    expect(summary).toContain("| GND | ground |");
    expect(summary).toContain("LED1 (Moon light 1 (leftmost))");
    expect(summary).toContain("Arduino D3");
  });
});
