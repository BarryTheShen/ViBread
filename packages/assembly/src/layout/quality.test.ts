import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { CircuitSchema, parseHole, type Circuit, type Layout, type Step } from "@vibread/core";

import { assemblyReport, buildSteps, jumperCrossings, landmarkHolds, layoutBoard, layoutQuality, lvs, placementSummary, renderBreadboardSvg, repeatedUnits } from "./index.js";

/**
 * Issue #26: every layout is scored by the design philosophy (HOW-IT-WORKS.md "Design philosophy"). Repeated units
 * are built as identical copies at a fixed pitch, in the order asked for, with parallel wires; explicit placement
 * requests are hard constraints.
 */
const fixture = (name: string): Circuit => CircuitSchema.parse(JSON.parse(readFileSync(new URL(`../../../../fixtures/schematic/${name}.json`, import.meta.url), "utf8")));
const on = (circuit: Circuit, profile: "bb-830" | "bb-400"): Circuit => ({ ...circuit, breadboard: { profile } });
const counter = fixture("binary-counter-button");

function column(hole: string): number {
  const parsed = parseHole(hole)!;
  return parsed.kind === "terminal" ? parsed.row : parsed.position;
}

function pins(layout: Layout, part: string): Record<string, string> {
  return layout.placements.find((placement) => placement.part === part)!.pins;
}

describe("design philosophy in the layout (issue #26)", () => {
  it.each(["bb-830", "bb-400"] as const)("binary counter on %s: one row at a fixed pitch, 16s on the left, identical drops, parallel wires, ≤ 9 wires", (profile) => {
    const circuit = on(counter, profile);
    const layout = layoutBoard(circuit);
    expect(lvs(circuit, layout).ok).toBe(true);
    const report = assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" });
    expect(report.verdict).toBe("GO");
    expect(report.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    // Left to right exactly as the placement group lists them (LED5 = 16s on D7 … LED1 = 1s on D3).
    const leds = ["LED5", "LED4", "LED3", "LED2", "LED1"];
    const columns = leds.map((id) => column(pins(layout, id).A!));
    const steps = columns.slice(1).map((value, index) => value - columns[index]!);
    expect(new Set(steps).size, `pitch ${steps}`).toBe(1);
    expect(steps[0]).toBeGreaterThanOrEqual(2);
    // Identical copies: every unit has the same shape relative to its column.
    const shape = (index: number) => {
      const led = pins(layout, leds[index]!);
      const resistor = pins(layout, `R${leds[index]!.slice(3)}`);
      const base = columns[index]!;
      return [led.A, led.K, resistor["1"], resistor["2"]].map((hole) => `${hole!.replace(/\d+$/, "")}${column(hole!) - base}`).join(" ");
    };
    for (const index of [1, 2, 3, 4]) expect(shape(index)).toBe(shape(0));
    expect(shape(0)).toBe("a0 T-0 f0 e0");
    expect(jumperCrossings(layout)).toEqual([]);
    expect(layout.jumpers.length).toBeLessThanOrEqual(9);
    expect(layoutQuality(circuit, layout).repeats).toEqual([expect.objectContaining({ regular: true, inOrder: true, orderedBy: "placement group" })]);
  });

  it("an explicit row keeps its order even when the pins run the other way: the Uno turns round so wires stay parallel", () => {
    const reversed: Circuit = { ...counter, placement: { groups: [["LED1", "LED2", "LED3", "LED4", "LED5"]] } };
    const layout = layoutBoard(reversed);
    const columns = ["LED1", "LED2", "LED3", "LED4", "LED5"].map((id) => column(pins(layout, id).A!));
    expect([...columns].sort((a, b) => a - b)).toEqual(columns);
    expect(placementSummary(reversed, layout).groups[0]!.met).toBe(true);
    // D3 … D7 left to right needs the digital header reading D0 … D13: USB socket on the right.
    expect([layoutBoard(counter).boardOrientation, layout.boardOrientation]).toEqual(["usb-left", "usb-right"]);
    expect(jumperCrossings(layout)).toEqual([]);
  });

  it("follows the positions part labels state, and warns when a layout contradicts them", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    // Without its placement group the labels ("Moon light 1 (leftmost)" … "(rightmost)") still decide the order.
    const unlabelledRow: Circuit = { ...moon, placement: undefined } as Circuit;
    for (const circuit of [moon, unlabelledRow]) {
      const layout = layoutBoard(circuit);
      const columns = ["LED1", "LED2", "LED3", "LED4"].map((id) => column(pins(layout, id).A!));
      expect([...columns].sort((a, b) => a - b)).toEqual(columns);
      expect(jumperCrossings(layout)).toEqual([]);
      expect(assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" }).findings.some((finding) => finding.ruleId === "LAYOUT-LABEL-ORDER")).toBe(false);
    }
    // Swap LED1 and LED4 in a finished layout: LED1 is no longer leftmost.
    const layout = layoutBoard(moon);
    const swapped: Layout = { ...layout, placements: layout.placements.map((placement) => placement.part === "LED1" ? { ...placement, part: "LED4" } : placement.part === "LED4" ? { ...placement, part: "LED1" } : placement) };
    const warning = assemblyReport({ circuit: moon, layout: swapped, lvs: lvs(moon, swapped), revisionHash: "test" }).findings.find((finding) => finding.ruleId === "LAYOUT-LABEL-ORDER");
    expect(warning?.severity).toBe("warning");
    expect(warning?.detail).toMatch(/LED1\b.*\b4th\b.*\b1st\b/);
    expect(warning?.detail).toMatch(/LED4\b.*\b1st\b.*\b4th\b/);
  });

  it("draws the Uno the way the layout turned it, and the orientation step says so", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    for (const [circuit, facing] of [[moon, "right"], [counter, "left"]] as const) {
      const layout = layoutBoard(circuit);
      expect(layout.boardOrientation).toBe(`usb-${facing}`);
      const svg = renderBreadboardSvg({ circuit, layout });
      expect(svg).toContain(facing === "right" ? "USB END ▶" : "◀ USB END");
      const x = (pin: string) => Number(svg.match(new RegExp(`<g id="pin-${pin}"><circle cx="([\\d.]+)"`))![1]);
      expect(Math.sign(x("D13") - x("D0"))).toBe(facing === "right" ? 1 : -1);
      expect(buildSteps(circuit, layout).steps[1]!.text).toContain(`its USB socket on the ${facing}`);
    }
  });

  it("a row that can't be built in the listed order is NO-GO the design can fix (not tool-side), with the real remedy", () => {
    const piano = fixture("mini-piano");
    const scrambled: Circuit = { ...piano, placement: { groups: [["LED1", "LED3", "LED2", "LED4"]] } };
    const layout = layoutBoard(scrambled);
    const summary = placementSummary(scrambled, layout);
    if (summary.groups[0]!.met) return; // the allocator managed it after all: nothing to report
    const report = assemblyReport({ circuit: scrambled, layout, lvs: lvs(scrambled, layout), revisionHash: "test" });
    const unmet = report.findings.find((finding) => finding.ruleId === "PLACEMENT-UNMET")!;
    expect(report.verdict).toBe("NO-GO");
    expect(summary.groups[0]!.orderOnly).toBe(true);
    expect(unmet.toolSide).toBeUndefined();
    expect(unmet.fix).toMatch(/order/);
    expect(unmet.fix).not.toMatch(/bigger breadboard/);
  });

  it("finds repeated units from the netlist alone, and nothing in a one-off design", () => {
    expect(repeatedUnits(counter).map((set) => set.copies.map((copy) => copy.parts.join("+")))).toEqual([["R5+LED5", "R4+LED4", "R3+LED3", "R2+LED2", "R1+LED1"]]);
    expect(repeatedUnits(GOLDEN.find((design) => design.key === "knob-night-light")!.circuit)).toEqual([]);
  });

  it("whack-a-mole: each button+resistor+light group built as identical copies in pin order, no crossing wires", () => {
    const circuit = fixture("whack-a-mole");
    const layout = layoutBoard(circuit);
    const quality = layoutQuality(circuit, layout);
    expect(lvs(circuit, layout).ok).toBe(true);
    expect(assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" }).verdict).toBe("GO");
    expect(placementSummary(circuit, layout).groups.every((group) => group.met)).toBe(true);
    expect(quality.repeats).toEqual([expect.objectContaining({ regular: true, copies: [["BTN1", "R1", "LED1"], ["BTN2", "R2", "LED2"], ["BTN3", "R3", "LED3"]] })]);
    // Before issue #26: 12 wires and 14 crossings (drawn with the real Uno header order).
    expect(quality.wires).toBeLessThanOrEqual(10);
    // Its two pin families (buttons D2–D4, lights D8–D10) interleave copy by copy: straight into row j they cross
    // (3 crossings), so the button wires land on the buttons' far half instead, the same hole in every copy.
    expect(jumperCrossings(layout)).toEqual([]);
    const landing = (net: string) => {
      const end = layout.jumpers.find((jumper) => jumper.net === net && "board" in jumper.from)!.to;
      return "hole" in end ? `${end.hole.replace(/\d+$/, "")}${column(end.hole) - column(pins(layout, `BTN${Number(net.slice(1)) - 1}`)["1"]!)}` : "board";
    };
    expect(new Set(["D2", "D3", "D4"].map(landing))).toEqual(new Set(["a0"]));
  });

  it.each(GOLDEN.map((design) => [design.key, design.circuit] as const))("%s: still GO, repeated units regular, no more wires than before", (key, circuit) => {
    const layout = layoutBoard(circuit);
    const report = assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" });
    expect(report.verdict).toBe("GO");
    const quality = layoutQuality(circuit, layout);
    expect(quality.irregular).toBe(0);
    // Wire counts before issue #26 (HEAD c31d45a): moon 16, knob 6, launch 12.
    expect(quality.wires).toBeLessThanOrEqual({ "moon-phase-lamp": 11, "knob-night-light": 6, "launch-control": 10 }[key]!);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #25: repeated units become one "build one" step and one "repeat ×N" step with a per-copy checklist.

describe("repeat ×N build steps (issue #25)", () => {
  const layout = layoutBoard(counter);
  const steps = buildSteps(counter, layout);
  const building = steps.steps.filter((step) => step.adds.parts.length > 0 || (step.adds.jumpers.length > 0 && step.kind !== "rails"));

  it("builds the binary counter in ≤ 4 steps: one light unit, repeat it, then the button with its wires", () => {
    expect(building.map((step) => step.title)).toEqual([
      "Build one light unit (1 of 5)",
      "Repeat ×4 more (5 in all), 3 columns right each time",
      "Insert BTN1 and its 2 wires",
    ]);
    const [template, repeat] = building as [Step, Step];
    expect(template.repeat).toMatchObject({ role: "template", count: 5, columns: 3, template: template.n });
    expect(repeat.repeat).toMatchObject({ role: "repeat", count: 5, columns: 3, template: template.n });
    // The template builds copy 1 (the 16s light on D7) with its own wire; the repeat step everything else.
    expect(template.adds).toEqual({ parts: ["R5", "LED5"], jumpers: [layout.jumpers.find((jumper) => jumper.net === "D7")!.id] });
    expect(repeat.adds.parts).toEqual(["R4", "LED4", "R3", "LED3", "R2", "LED2", "R1", "LED1"]);
    // Every piece of the layout is built exactly once across all steps.
    const parts = steps.steps.flatMap((step) => step.adds.parts).sort();
    const jumpers = steps.steps.flatMap((step) => step.adds.jumpers).sort();
    expect(parts).toEqual(layout.placements.map((placement) => placement.part).sort());
    expect(jumpers).toEqual(layout.jumpers.map((jumper) => jumper.id).sort());
  });

  it("gives a checklist line per copy with its Arduino pin, holes and wire colour, each copy exactly one pitch right of the last", () => {
    const repeat = building[1]!;
    const copies = repeat.repeat!.copies;
    const start = copies[0]!.column;
    expect(copies.map((copy) => [copy.index, copy.boardPins, copy.column])).toEqual([[1, ["D7"], start], [2, ["D6"], start + 3], [3, ["D5"], start + 6], [4, ["D4"], start + 9], [5, ["D3"], start + 12]]);
    for (const copy of copies.slice(1)) {
      expect(repeat.text).toContain(copy.text.split(":")[0]!.replace(/ \(.*/, ""));
      for (const hole of copy.holes) expect(repeat.text).toContain(hole);
      const wire = layout.jumpers.find((jumper) => jumper.id === copy.jumpers[0])!;
      expect(repeat.text).toContain(`${/^[aeiou]/.test(wire.color) ? "an" : "a"} ${wire.color} wire from Arduino pin ${copy.boardPins[0]}`);
    }
    expect(new Set(repeat.holes)).toEqual(new Set(copies.slice(1).flatMap((copy) => copy.holes)));
    for (const landmark of repeat.landmarks ?? []) expect(landmarkHolds(layout, landmark)).toBe(true);
    expect(repeat.landmarks).toHaveLength(4);
  });

  it("draws the ×5 badge with ghosted copies on the first unit; the repeat step ends in a one-line banner under the whole board and the focus crop", () => {
    const [template, repeat] = building as [Step, Step];
    for (const focus of [false, true]) {
      const first = renderBreadboardSvg({ circuit: counter, layout, steps, upToStep: template.n, focus });
      expect(first).toContain(">×5</text>");
      expect([...first.matchAll(/class="repeat-ghost" data-repeat-copy="(\d)"/g)].map((match) => match[1])).toEqual(["2", "3", "4", "5"]);
      const rest = renderBreadboardSvg({ circuit: counter, layout, steps, upToStep: repeat.n, focus });
      expect(rest).toContain(">×5 · 3 columns apart</text>");
      // Each copy keeps its number and Arduino pin on the board in both views.
      expect([...rest.matchAll(/class="ghost-label" data-repeat-copy="(\d)"/g)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "5"]);
      // No drawn checklist in either view: the screens beside the picture have the tickable one (issue #25 follow-up).
      expect([...rest.matchAll(/data-repeat-check="(\d)"/g)]).toEqual([]);
      expect(rest).toContain('data-repeat-banner="4"');
      expect(rest).toContain(">Repeat ×4 more · 3 columns right each time</text>");
    }
    // The banner leaves the phone picture mostly board: under a sixth of its height (the drawn checklist took ~40 %).
    const focused = renderBreadboardSvg({ circuit: counter, layout, steps, upToStep: repeat.n, focus: true });
    const total = Number(/^<svg[^>]* viewBox="[^ ]+ [^ ]+ [^ ]+ ([^"]+)"/.exec(focused)![1]);
    const scale = Number(/id="parts-panel" transform="translate\([^)]*\) scale\(([^)]+)\)"/.exec(focused)![1]);
    expect((96 * scale) / total).toBeLessThan(1 / 6);
  });

  it("falls back to one step per part and wire when the copies are not regular", () => {
    // Shift the last copy (R1, LED1 and its wire) one column right: same circuit, no longer an even row.
    const shift = (hole: string) => hole.replace(/(\d+)$/, (value) => String(Number(value) + 1));
    const wire = layout.jumpers.find((jumper) => jumper.net === "D3")!;
    const irregular: Layout = {
      ...layout,
      placements: layout.placements.map((placement) => (["R1", "LED1"].includes(placement.part) ? { ...placement, pins: Object.fromEntries(Object.entries(placement.pins).map(([pin, hole]) => [pin, shift(hole)])) } : placement)),
      jumpers: layout.jumpers.map((jumper) => (jumper.id === wire.id && "hole" in jumper.to ? { ...jumper, to: { hole: shift(jumper.to.hole) } } : jumper)),
    };
    expect(lvs(counter, irregular).ok).toBe(true);
    const fallback = buildSteps(counter, irregular);
    expect(fallback.steps.some((step) => step.repeat)).toBe(false);
    expect(fallback.steps.filter((step) => step.adds.parts.includes("LED1"))).toHaveLength(1);
    expect(fallback.steps.filter((step) => step.kind === "place" || step.kind === "jumper").length).toBeGreaterThan(4);
  });
});
