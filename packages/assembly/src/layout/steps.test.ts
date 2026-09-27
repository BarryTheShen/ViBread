import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CircuitSchema, type Circuit } from "@vibread/core";

import { buildSteps, layoutBoard, renderBreadboardSvg } from "./index.js";

const fixture = (name: string): Circuit => CircuitSchema.parse(JSON.parse(readFileSync(new URL(`../../../../fixtures/schematic/${name}.json`, import.meta.url), "utf8")));

describe("build step wording a first-time maker reads", () => {
  it("names catalogue parts as written, in the inventory, the title and the text (not 'other part', not 'Hc-sr04')", () => {
    const circuit = fixture("distance-rgb");
    const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
    expect(steps[0]!.text).toContain("1 HC-SR04 distance sensor, 1 RGB LED (common cathode)");
    expect(steps[0]!.text).not.toContain("other part");
    const sensor = steps.find((step) => step.adds.parts.includes("U1"))!;
    expect(sensor.title).toBe("Insert U1 — HC-SR04 distance sensor");
    expect(sensor.text).toMatch(/^HC-SR04 distance sensor U1: VCC in hole /);
  });

  it("says which rail a leg's rail hole is on, as it does for a wire's", () => {
    const circuit = fixture("binary-counter");
    const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
    const template = steps.find((step) => step.repeat?.role === "template")!;
    expect(template.text).toMatch(/short leg \(−, flat side\) in hole T-\d+ on the blue − rail \(GND\)/);
  });

  it("names a resistor's legs upper and lower when both sit in one column, and drops far-off 'N columns' landmarks", () => {
    const circuit = fixture("binary-counter");
    const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
    const template = steps.find((step) => step.repeat?.role === "template")!;
    // R1 is in f12 and e12: the LED's long leg and the Arduino wire share a strip with one of them, so say which.
    expect(template.text).toContain("in hole a12, same strip as R1's upper leg");
    expect(template.text).toContain("hole j12 (same strip as R1's lower leg)");
    // R1's first leg is 48 columns from the only earlier item (the GND wire's rail end): no landmark at all.
    expect(template.text).toContain("one leg in hole f12; the other");
    const all = steps.map((step) => step.text).join(" ");
    for (const match of all.matchAll(/(\d+) columns? (?:left|right) of/g)) expect(Number(match[1])).toBeLessThanOrEqual(10);
  });

  it("lists a four-legged copy's holes as a list, not 'and … and … and'", () => {
    const circuit = fixture("dishwasher-panel");
    const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
    const repeat = steps.find((step) => step.repeat?.role === "repeat" && step.adds.parts.includes("BTN2"))!;
    expect(repeat.text).toMatch(/BTN2 in holes e\d+, f\d+, e\d+ and f\d+;/);
  });
});

describe("step pictures", () => {
  it("keeps 'CENTRE CHANNEL' clear of the repeat badge and of every part across the channel", () => {
    const circuit = fixture("whack-a-mole");
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    const repeat = steps.steps.find((step) => step.repeat?.role === "repeat")!;
    for (const focus of [false, true]) {
      const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: repeat.n, focus });
      const label = /<text x="([\d.]+)" y="[\d.]+" text-anchor="middle" class="[^"]*channel-label[^"]*">CENTRE CHANNEL<\/text>/.exec(svg);
      expect(label).not.toBeNull();
      const x = Number(label![1]);
      const [left, right] = [x - 58, x + 58];
      const badge = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="26" rx="13" class="[^"]*repeat-badge-bg/.exec(svg)!;
      expect(Number(badge[1]) + Number(badge[2]) <= left || Number(badge[1]) >= right).toBe(true);
      // Column x from the numbered labels over the board (columns 1 and 5).
      const columnX = (n: number) => Number(new RegExp(`<text x="([\\d.]+)"[^>]*class="[^"]*base-row-label[^>]*>${n}</text>`).exec(svg)![1]);
      const pitch = (columnX(5) - columnX(1)) / 4;
      const across = layout.placements.filter((placement) => {
        const holes = Object.values(placement.pins);
        return holes.some((hole) => /^[a-e]\d/.test(hole)) && holes.some((hole) => /^[f-j]\d/.test(hole));
      });
      expect(across.length).toBeGreaterThan(0);
      for (const placement of across) {
        for (const hole of Object.values(placement.pins)) {
          const hx = columnX(1) + (Number(hole.slice(1)) - 1) * pitch;
          expect(hx < left - 8 || hx > right + 8).toBe(true);
        }
      }
    }
  });

  it("leaves the 'Columns 1–63' key out of a focus crop that would cut it", () => {
    const circuit = fixture("binary-counter");
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    const template = steps.steps.find((step) => step.repeat?.role === "template")!;
    expect(renderBreadboardSvg({ circuit, layout, steps, upToStep: template.n })).toContain('class="legend"');
    const focused = renderBreadboardSvg({ circuit, layout, steps, upToStep: template.n, focus: true });
    const [x, , width] = /^<svg[^>]* viewBox="([^ ]+) ([^ ]+) ([^ ]+)/.exec(focused)!.slice(1).map(Number);
    // This crop ends left of the key (drawn at x ≈ 1000–1190), so the key is not drawn half-cut.
    expect(x! + width!).toBeLessThan(1190);
    expect(focused).not.toContain('class="legend"');
  });
});
