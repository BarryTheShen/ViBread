import { readFileSync } from "node:fs";
import { CircuitSchema, parseHole, parseSuiteYaml, type Actor, type Circuit, type Layout } from "@vibread/core";
import { jumperCrossings, placementSummary } from "@vibread/assembly";
import { createPipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { memoryStore } from "./testing.js";

/**
 * Issue #26 end to end, without Claude: the design the agent should produce for "Make a binary counter on 5 LEDs
 * horizontally next to each other incremented with a button" (the tester's r1: sketch, parts and nets from its project
 * files, plus the placement request the prompt now asks for) through the real pipeline, checked against the hand-built
 * board: one row, even spacing, 16s on the left, identical resistor drops, parallel wires, the button off to one side.
 */
const circuit: Circuit = CircuitSchema.parse(JSON.parse(readFileSync(new URL("../../../../fixtures/schematic/binary-counter-button.json", import.meta.url), "utf8")));

/** What the independent test author plausibly writes for the intent (it never sees the sketch). */
const SUITE = parseSuiteYaml(`schema: vibread.sim/v1
author: fixture
scenarios:
  - id: T1
    title: At power-on every light is off
    clauses: [C1]
    categories: [power-on]
    steps:
      - wait: 200
      - expect-part: { part: LED1, state: off }
      - expect-part: { part: LED2, state: off }
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: LED4, state: off }
      - expect-part: { part: LED5, state: off }
  - id: T2
    title: Five presses show 5 (1s and 4s lights on)
    clauses: [C1]
    categories: [normal]
    steps:
      - wait: 200
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - wait: 100
      - expect-part: { part: LED1, state: on }
      - expect-part: { part: LED2, state: off }
      - expect-part: { part: LED3, state: on }
      - expect-part: { part: LED4, state: off }
      - expect-part: { part: LED5, state: off }
  - id: T3
    title: Thirty-one presses light every light, the next press turns them all off
    clauses: [C1, C2]
    categories: [normal]
    steps:
      - wait: 200
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - press: { part: BTN1 }
      - wait: 100
      - expect-part: { part: LED1, state: on }
      - expect-part: { part: LED2, state: on }
      - expect-part: { part: LED3, state: on }
      - expect-part: { part: LED4, state: on }
      - expect-part: { part: LED5, state: on }
      - press: { part: BTN1 }
      - wait: 100
      - expect-part: { part: LED1, state: off }
      - expect-part: { part: LED2, state: off }
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: LED4, state: off }
      - expect-part: { part: LED5, state: off }
  - id: T4
    title: A bouncing press counts once
    clauses: [C1]
    categories: [bounce]
    steps:
      - wait: 200
      - bounce: { part: BTN1, to: true }
      - wait: 150
      - bounce: { part: BTN1, to: false }
      - wait: 200
      - expect-part: { part: LED1, state: on }
      - expect-part: { part: LED2, state: off }
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: LED4, state: off }
      - expect-part: { part: LED5, state: off }
  - id: T5
    title: Three quick presses count as three
    clauses: [C1]
    categories: [rapid]
    steps:
      - wait: 200
      - press: { part: BTN1, holdMs: 60, gapMs: 60 }
      - press: { part: BTN1, holdMs: 60, gapMs: 60 }
      - press: { part: BTN1, holdMs: 60, gapMs: 60 }
      - wait: 100
      - expect-part: { part: LED1, state: on }
      - expect-part: { part: LED2, state: on }
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: LED4, state: off }
      - expect-part: { part: LED5, state: off }
`);

const AUTHOR: Actor = { kind: "agent", id: "design-agent", channel: "web" };

function column(hole: string): number {
  const parsed = parseHole(hole)!;
  return parsed.kind === "terminal" ? parsed.row : parsed.position;
}

describe("binary counter on 5 LEDs in a row (issue #26)", () => {
  it("passes every console and is laid out like the hand-built board", async () => {
    const store = memoryStore();
    const mission = await store.createMission({ title: "Binary counter", brief: "Make a binary counter on 5 LEDs horizontally next to each other incremented with a button", ownerId: "o", inventory: [] });
    await store.createRevision(mission.id, { circuit, suite: SUITE, author: AUTHOR });
    const results = await createPipeline({ store, faults: false }).evaluate(mission.id, 1);
    const verdicts = Object.fromEntries(results.reports.map((report) => [report.console, report.verdict]));
    expect(verdicts).toMatchObject({ EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO" });
    const fao = results.reports.find((report) => report.console === "FAO")!;
    expect(fao.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(fao.evidence?.layoutDecision).toMatchObject({ chosen: expect.stringContaining("identical copies") });

    const layout = results.layout as Layout;
    const at = (part: string) => layout.placements.find((placement) => placement.part === part)!.pins;
    // One row, 16s on the left: LED5 … LED1 left to right at one fixed spacing, all the same shape.
    const leds = ["LED5", "LED4", "LED3", "LED2", "LED1"];
    const columns = leds.map((id) => column(at(id).A!));
    const pitch = columns[1]! - columns[0]!;
    expect(pitch).toBeGreaterThan(0);
    expect(columns.slice(1).map((value, index) => value - columns[index]!)).toEqual([pitch, pitch, pitch, pitch]);
    for (const id of leds) expect([at(id).A![0], parseHole(at(id).K!)?.kind]).toEqual(["a", "rail"]);
    // Each resistor straight below its LED, the same way round, across the channel.
    leds.forEach((id, index) => {
      const r = at(`R${id.slice(3)}`);
      expect([column(r["1"]!), column(r["2"]!)]).toEqual([columns[index], columns[index]]);
      expect([r["1"]![0], r["2"]![0]]).toEqual(["f", "e"]);
    });
    // The button off to one side of the lights.
    const button = Object.values(at("BTN1")).map(column);
    expect(Math.min(...button) > Math.max(...columns) || Math.max(...button) < Math.min(...columns)).toBe(true);
    // One wire per light, parallel (no crossings), 8 wires in all like the hand build.
    expect(layout.jumpers.length).toBeLessThanOrEqual(9);
    expect(jumperCrossings(layout)).toEqual([]);
    expect(placementSummary(circuit, layout).groups.map((group) => group.met)).toEqual([true]);
    // Colours by role: GND black, the five light wires one family in row order.
    expect(layout.jumpers.filter((jumper) => jumper.net === "GND").map((jumper) => jumper.color)).toEqual(expect.arrayContaining(["black"]));
    expect(new Set(layout.jumpers.filter((jumper) => jumper.net === "GND").map((jumper) => jumper.color))).toEqual(new Set(["black"]));
    const lightWires = ["D7", "D6", "D5", "D4", "D3"].map((net) => layout.jumpers.find((jumper) => jumper.net === net)!.color);
    // The button's line takes the first colour (D2), then the five lights one family in row order.
    expect(lightWires).toEqual(["yellow", "green", "blue", "purple", "white"]);
  }, 180_000);
});
