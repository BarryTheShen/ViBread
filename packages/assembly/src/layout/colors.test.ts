import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { KIT_WIRE_CSS } from "@vibread/core";
import { buildSteps, defaultNetColors, jumperColors, layoutBoard, netColors, renderBreadboardSvg, wireLegend } from "./index.js";

const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
const launch = GOLDEN.find((design) => design.key === "launch-control")!.circuit;

describe("default wire colours (issue #15)", () => {
  it("reserves red for 5 V and black for GND, and gives same-role lines consecutive resistor-code colours in pin order", () => {
    const colors = defaultNetColors(moon);
    expect(colors["5V"]).toBe("red");
    expect(colors.GND).toBe("black");
    // LED lines D3–D6 in pin order; each line keeps its colour through the resistor (L1…L4).
    expect(["D3", "D4", "D5", "D6"].map((net) => colors[net])).toEqual(["yellow", "green", "blue", "purple"]);
    expect(["L1", "L2", "L3", "L4"].map((net) => colors[net])).toEqual(["yellow", "green", "blue", "purple"]);
    const signals = Object.entries(colors).filter(([net]) => net !== "5V" && net !== "GND").map(([, color]) => color);
    expect(signals).not.toContain("red");
    expect(signals).not.toContain("black");
  });

  it("colours neighbouring Arduino pins differently and every wire of a net alike", () => {
    const colors = defaultNetColors(launch);
    const byPin = ["D2", "D3", "D4", "D5", "D6", "D8"].map((net) => colors[net]);
    for (let index = 1; index < byPin.length; index += 1) expect(byPin[index]).not.toBe(byPin[index - 1]);
    const layout = layoutBoard(launch);
    for (const jumper of layout.jumpers) expect(jumper.color).toBe(colors[jumper.net]);
  });

  it("writes a short legend grouping same-role lines", () => {
    const layout = layoutBoard(moon);
    expect(wireLegend(moon, layout)).toEqual(expect.arrayContaining([
      { colors: ["red"], label: "5V (power)" },
      { colors: ["black"], label: "GND (ground)" },
      { colors: ["yellow", "green", "blue", "purple"], label: "LED1–LED4 (D3–D6)" },
    ]));
  });
});

describe("builder wire-colour overrides (issue #15)", () => {
  const layout = layoutBoard(moon);
  const d4 = layout.jumpers.find((jumper) => jumper.net === "D4")!;
  const gnd = layout.jumpers.filter((jumper) => jumper.net === "GND");

  it("applies a single-wire choice over a whole-net choice over the suggestion", () => {
    const overrides = { "net:GND": "blue", [`wire:${gnd[0]!.id}`]: "#ff66aa", [`wire:${d4.id}`]: "white" };
    const colors = jumperColors(moon, layout, overrides);
    expect(colors[gnd[0]!.id]).toBe("#ff66aa");
    for (const jumper of gnd.slice(1)) expect(colors[jumper.id]).toBe("blue");
    expect(colors[d4.id]).toBe("white");
    expect(netColors(moon, overrides).D4).toBe("green");
    // Invalid values are ignored rather than drawn.
    expect(jumperColors(moon, layout, { [`wire:${d4.id}`]: "not-a-colour" })[d4.id]).toBe("green");
  });

  it("carries the choice into step text, the picture, and the legend", () => {
    const overrides = { [`wire:${d4.id}`]: "#ff66aa", "net:GND": "blue" };
    const wireColors = jumperColors(moon, layout, overrides);
    const steps = buildSteps(moon, layout, { wireColors });
    const step = steps.steps.find((candidate) => candidate.adds.jumpers.includes(d4.id))!;
    expect(step.text).toContain("Connect a custom-colour (#ff66aa) wire");
    expect(steps.steps.find((candidate) => candidate.kind === "rails")!.text).toContain("connect a blue wire from Arduino GND header pin");
    const svg = renderBreadboardSvg({ circuit: moon, layout, steps, upToStep: step.n, wireColors });
    const wire = svg.match(new RegExp(`<g id="wire-${d4.id}"[\\s\\S]*?</g>`))?.[0] ?? "";
    expect(wire).toContain('stroke="#ff66aa"');
    const ground = svg.match(new RegExp(`<g id="wire-${gnd[0]!.id}"[\\s\\S]*?</g>`))?.[0] ?? "";
    expect(ground).toContain(`stroke="${KIT_WIRE_CSS.blue}"`);
    expect(wireLegend(moon, layout, overrides)).toEqual(expect.arrayContaining([
      { colors: ["blue"], label: "GND (ground)" },
      { colors: ["#ff66aa"], label: `${d4.id} (D4)` },
    ]));
  });
});
