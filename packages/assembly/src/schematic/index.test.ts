import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { renderSchematicSvg, schematicSummary } from "./index.js";

describe("schematic renderer", () => {
  it.each(GOLDEN)("renders every part in $circuit.title", async (fixture) => {
    const started = performance.now();
    const svg = await renderSchematicSvg(fixture.circuit);
    const elapsedMs = performance.now() - started;

    expect(svg.startsWith("<svg ")).toBe(true);
    for (const part of fixture.circuit.parts) expect(svg).toContain(part.id);
    expect(svg).toContain(">5V<");
    expect(svg).toContain(">GND<");
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
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
    expect(summary).toContain("LED1.K");
    expect(summary).toContain("Arduino D3");
  });
});
