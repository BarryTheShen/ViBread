import { describe, expect, it } from "vitest";

import { GOLDEN } from "@vibread/fixtures";
import { CircuitSchema, ENVELOPE, parseCircuit, parseHole, validateCircuit, type Circuit, type Layout } from "@vibread/core";

import { LayoutFitError, assemblyReport, buildSteps, landmarkHolds, layoutBoard, layoutFailureReport, layoutHash, lvs, placementSummary } from "./index.js";
import { svgToPng } from "../png.js";
import { renderBreadboardSvg } from "./svg.js";

function issueKinds(circuit: (typeof GOLDEN)[number]["circuit"], layout: Layout): string[] {
  return [...new Set(lvs(circuit, layout).issues.map((issue) => issue.kind))].sort();
}
function replayLayout(layout: Layout, steps: ReturnType<typeof buildSteps>["steps"]): Layout {
  const placementByPart = new Map(layout.placements.map((placement) => [placement.part, placement]));
  const jumperById = new Map(layout.jumpers.map((jumper) => [jumper.id, jumper]));
  const placements: Layout["placements"] = [];
  const jumpers: Layout["jumpers"] = [];
  const seenParts = new Set<string>();
  const seenJumpers = new Set<string>();
  for (const step of steps) {
    for (const partId of step.adds.parts) {
      if (seenParts.has(partId)) throw new Error(`part ${partId} was added twice`);
      const placement = placementByPart.get(partId);
      if (!placement) throw new Error(`missing placement for ${partId}`);
      seenParts.add(partId);
      placements.push(placement);
    }
    for (const jumperId of step.adds.jumpers) {
      if (seenJumpers.has(jumperId)) throw new Error(`jumper ${jumperId} was added twice`);
      const jumper = jumperById.get(jumperId);
      if (!jumper) throw new Error(`missing jumper ${jumperId}`);
      seenJumpers.add(jumperId);
      jumpers.push(jumper);
    }
  }
  placements.sort((a, b) => a.part.localeCompare(b.part));
  jumpers.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { ...layout, placements, jumpers };
}

function textHoleIds(text: string): string[] {
  return [...new Set(text.match(/\b(?:[a-j]\d{1,2}|[TB][+-]\d{1,2})\b/g) ?? [])].sort();
}

function assertStepContract(circuit: Circuit): void {
  const layout = layoutBoard(circuit);
  const steps = buildSteps(circuit, layout);
  const rebuilt = replayLayout(layout, steps.steps);
  expect(rebuilt).toEqual(layout);
  expect(lvs(circuit, rebuilt).ok).toBe(true);
  for (const step of steps.steps) {
    if (step.kind === "place" || step.kind === "jumper" || step.kind === "rails") {
      expect(textHoleIds(step.text)).toEqual([...new Set(step.holes)].sort());
      expect(step.plug).toBe("unplugged");
    }
    if (step.adds.parts.length > 0 || step.adds.jumpers.length > 0) expect(step.plug).toBe("unplugged");
    if (step.plug === "plugged") expect(["checkpoint", "power-up"]).toContain(step.kind);
  }
  const pluggedBeforeFinal = steps.steps.slice(0, -1).filter((step) => step.plug === "plugged");
  expect(pluggedBeforeFinal.every((step) => step.kind === "checkpoint")).toBe(true);
}

describe("deterministic breadboard layout", () => {
  it("keeps every golden design LVS-clean and FAO GO", () => {
    for (const design of GOLDEN) {
      const layout = layoutBoard(design.circuit);
      const result = lvs(design.circuit, layout);
      expect(result.ok, design.key).toBe(true);
      const report = assemblyReport({ circuit: design.circuit, layout, lvs: result, revisionHash: "test" });
      expect(report.verdict, design.key).toBe("GO");
      expect(report.summary, design.key).toBe("The breadboard fits and LVS is clean.");
    }
  });
  it("replays structured steps exactly and keeps text/data/plug contracts", () => {
    for (const design of GOLDEN) assertStepContract(design.circuit);
    const knob = GOLDEN.find((design) => design.key === "knob-night-light")!.circuit;
    assertStepContract({ ...knob, title: "Recorded custom knob run", assumptions: [...knob.assumptions, "Recorded non-golden verification"] });
  });
  it("reports the exact topology mutant kinds", () => {
    const circuit = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const clean = layoutBoard(circuit);

    const used = new Set([...clean.placements.flatMap((placement) => Object.values(placement.pins)), ...clean.jumpers.flatMap((jumper) => [jumper.from, jumper.to]).flatMap((end) => ("hole" in end ? [end.hole] : []))]);
    const emptyRow = Array.from({ length: 63 }, (_, index) => 63 - index).find((row) => "abcde".split("").every((column) => !used.has(`${column}${row}`)))!;
    const moved = structuredClone(clean);
    moved.placements.find((placement) => placement.part === "R1")!.pins["1"] = `a${emptyRow}`;
    expect(issueKinds(circuit, moved)).toEqual(["split-net"]);

    const missing = structuredClone(clean);
    missing.jumpers.splice(missing.jumpers.findIndex((jumper) => "board" in jumper.from && jumper.from.board === "D3"), 1);
    expect(issueKinds(circuit, missing)).toEqual(["split-net"]);

    // R1's first lead moved into a free hole of LED2's anode strip (another signal net).
    const anode = clean.placements.find((placement) => placement.part === "LED2")!.pins.A!;
    const columns = "abcde".includes(anode[0]!) ? "abcde" : "fghij";
    const intruder = columns.split("").map((column) => `${column}${anode.slice(1)}`).find((hole) => !used.has(hole))!;
    const merged = structuredClone(clean);
    merged.placements.find((placement) => placement.part === "R1")!.pins["1"] = intruder;
    expect(issueKinds(circuit, merged)).toEqual(["merged-nets", "split-net"]);

    const shorted = structuredClone(clean);
    shorted.jumpers.push({ id: "WX", from: { hole: "T+2" }, to: { hole: "T-2" }, color: "red", net: "5V" });
    expect(issueKinds(circuit, shorted)).toEqual(["merged-nets", "power-short"]);
  });

  it("builds the safe plug-state order and fits moon phase on bb-400", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(moon);
    expect(layout.jumpers.length).toBeLessThanOrEqual(16);
    const steps = buildSteps(moon, layout);
    expect(steps.steps.every((step) => step.plug === "unplugged" || step.plug === "plugged")).toBe(true);
    expect(steps.steps.slice(0, 7).map((step) => step.kind)).toEqual(["inventory", "orientation", "checkpoint", "unplug", "rails", "checkpoint", "unplug"]);
    expect(steps.steps[5].plug).toBe("plugged");
    expect(steps.steps[5].checkpoint?.tests).toEqual(["rails.vcc"]);
    expect(steps.steps[5].text).not.toContain("rails.vcc");
    // The rails step wires exactly the Arduino 5 V and GND headers to their rails.
    const railWires = steps.steps[4].adds.jumpers.map((id) => layout.jumpers.find((jumper) => jumper.id === id)!);
    expect(railWires.map((jumper) => ["board" in jumper.from ? jumper.from.board : "", "hole" in jumper.to ? jumper.to.hole[0] + jumper.to.hole[1] : ""]).sort()).toEqual([["5V", "T+"], ["GND", "T-"]]);
    expect(steps.steps.at(-1)?.kind).toBe("power-up");
    expect(steps.steps.at(-1)?.plug).toBe("plugged");

    expect(steps.steps[1].text).toContain("Columns 1–63 run left to right");
    const resistorStep = steps.steps.find((step) => step.title.startsWith("Insert R5"))!;
    expect(resistorStep.text).toMatch(/10 kΩ resistor R5 \(brown-black-orange-gold\), either way round: one leg in hole [a-j]\d+[^;]*; the other in hole [a-j]\d+/);
    const a0 = layout.jumpers.find((jumper) => "board" in jumper.from && jumper.from.board === "A0")!;
    const jumperStep = steps.steps.find((step) => step.adds.jumpers.includes(a0.id))!;
    expect(jumperStep.text).toMatch(new RegExp(`End 1: Arduino pin A0 \\(.+\\)\\. End 2: hole ${"hole" in a0.to ? a0.to.hole : ""}\\b`));
    const half = { ...moon, breadboard: { profile: "bb-400" as const } };
    const halfLayout = layoutBoard(half);
    expect(lvs(half, halfLayout).ok).toBe(true);
  });
  it("focuses a step around every new hole", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(moon);
    const steps = buildSteps(moon, layout);
    const step = steps.steps[7];
    const svg = renderBreadboardSvg({ circuit: moon, layout, steps, upToStep: step.n, focus: true });
    const box = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
    expect(box).toHaveLength(4);
    const [x, y, width, height] = box!;
    for (const hole of step.holes) {
      const point = svg.match(new RegExp(`id="hole-${hole}"[^>]*cx="([\\d.]+)"[^>]*cy="([\\d.]+)"`));
      expect(point, hole).not.toBeNull();
      const px = Number(point?.[1]);
      const py = Number(point?.[2]);
      expect(px).toBeGreaterThanOrEqual(x);
      expect(px).toBeLessThanOrEqual(x + width);
      expect(py).toBeGreaterThanOrEqual(y);
      expect(py).toBeLessThanOrEqual(y + height);
    }
  });
  it("scopes breadboard CSS to the drawing root", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const svg = renderBreadboardSvg({ circuit: moon, layout: layoutBoard(moon) });
    const style = svg.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(style).not.toMatch(/(?:^|[},])\s*(?:svg|g|circle|text)\s*\{/m);
    expect(style).toContain('svg[data-vibread="breadboard"]');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #13: every net must be realized, not just the resistor→LED special case.

type Ref = { part: string; pin: string };
const board = (pin: string): Ref => ({ part: "board", pin });
const pin = (part: string, id: string): Ref => ({ part, pin: id });

function circuitOf(input: { parts: unknown[]; nets: unknown[]; roles: unknown[]; breadboard?: "bb-830" | "bb-400"; placement?: unknown }): Circuit {
  return CircuitSchema.parse({
    schema: "vibread.circuit/0.1",
    title: "Layout regression",
    summary: "Layout regression circuit.",
    board: { profile: "uno-r3-atmega328p-5v" },
    breadboard: { profile: input.breadboard ?? "bb-830" },
    parts: input.parts,
    nets: input.nets,
    roles: input.roles,
    sketch: { source: "void setup() {}\nvoid loop() {}\n" },
    intent: [{ id: "C1", text: "Regression." }],
    ...(input.placement ? { placement: input.placement } : {}),
  });
}

/** The tester's mini piano: 4 keys D2–D5, D8 → 1 kΩ → passive buzzer; `ledPerKey` adds rev 5's key lights. */
function piano(ledPerKey: boolean): Circuit {
  const keys = [1, 2, 3, 4];
  return circuitOf({
    parts: [
      ...keys.map((i) => ({ id: `BTN${i}`, module: "button", label: `Key ${i}`, params: {} })),
      { id: "R1", module: "resistor", params: { ohms: 1000, tolerancePct: 5 } },
      { id: "BZ1", module: "buzzer-passive", params: {} },
      ...(ledPerKey ? keys.map((i) => ({ id: `LED${i}`, module: "led", params: { color: "red" } })) : []),
      ...(ledPerKey ? [{ id: "R2", module: "resistor", params: { ohms: 220, tolerancePct: 5 } }] : []),
    ],
    nets: [
      { id: "GND", kind: "ground", pins: [board("GND"), ...keys.map((i) => pin(`BTN${i}`, "3")), pin("BZ1", "N")] },
      ...keys.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1"), ...(ledPerKey ? [pin(`LED${i}`, "K")] : [])] })),
      { id: "D8", kind: "signal", pins: [board("D8"), pin("R1", "1")] },
      { id: "SPK", kind: "signal", pins: [pin("R1", "2"), pin("BZ1", "P")] },
      ...(ledPerKey
        ? [
            { id: "5V", kind: "power", pins: [board("5V"), pin("R2", "1")] },
            { id: "LA", kind: "signal", pins: [pin("R2", "2"), ...keys.map((i) => pin(`LED${i}`, "A"))] },
          ]
        : []),
    ],
    roles: [
      ...keys.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: `Key ${i}` })),
      { pin: "D8", mode: "OUTPUT", part: "BZ1", purpose: "Speaker" },
    ],
  });
}

function assertBuildable(circuit: Circuit): Layout {
  const layout = layoutBoard(circuit);
  const result = lvs(circuit, layout);
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(assemblyReport({ circuit, layout, lvs: result, revisionHash: "test" }).verdict).toBe("GO");
  assertStepContract(circuit);
  return layout;
}

/** Seeded random circuits built from the patterns Claude designs, all valid and inside ENVELOPE. */
function randomCircuit(seed: number): Circuit {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const choose = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const digital = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"].sort(() => random() - 0.5);
  const analog = ["A0", "A1", "A2", "A3", "A4", "A5"].sort(() => random() - 0.5);
  const parts: { id: string; module: string; params: Record<string, unknown>; pinout?: unknown[]; label?: string }[] = [];
  const nets: { id: string; kind: string; pins: Ref[] }[] = [];
  const roles: { pin: string; mode: string; part: string; purpose: string }[] = [];
  const ground: Ref[] = [board("GND")];
  const power: Ref[] = [board("5V")];
  const counters: Record<string, number> = {};
  const next = (prefix: string) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;
  const signal = (...pins: Ref[]) => nets.push({ id: `N${nets.length + 1}`, kind: "signal", pins });
  const blocks: Record<string, () => boolean> = {
    led() {
      const [led, resistor, io] = [next("LED"), next("R"), digital.pop()];
      if (!io) return false;
      parts.push({ id: led, module: "led", params: { color: "red" } }, { id: resistor, module: "resistor", params: { ohms: 220 } });
      signal(board(io), pin(resistor, "1"));
      signal(pin(resistor, "2"), pin(led, "A"));
      ground.push(pin(led, "K"));
      roles.push({ pin: io, mode: "OUTPUT", part: led, purpose: "light" });
      return true;
    },
    chain() {
      const [led, first, second, io] = [next("LED"), next("R"), next("R"), digital.pop()];
      if (!io) return false;
      parts.push({ id: led, module: "led", params: { color: "green" } }, { id: first, module: "resistor", params: { ohms: 100 } }, { id: second, module: "resistor", params: { ohms: 120 } });
      signal(board(io), pin(first, "1"));
      signal(pin(first, "2"), pin(second, "1"));
      signal(pin(second, "2"), pin(led, "A"));
      ground.push(pin(led, "K"));
      roles.push({ pin: io, mode: "OUTPUT", part: led, purpose: "light" });
      return true;
    },
    button() {
      const [button, io] = [next("BTN"), digital.pop()];
      if (!io) return false;
      parts.push({ id: button, module: "button", params: {} });
      signal(board(io), pin(button, choose(["1", "2"])));
      ground.push(pin(button, choose(["3", "4"])));
      roles.push({ pin: io, mode: "INPUT_PULLUP", part: button, purpose: "key" });
      return true;
    },
    keyLight() {
      const [button, led, io] = [next("BTN"), next("LED"), digital.pop()];
      if (!io) return false;
      parts.push({ id: button, module: "button", params: {} }, { id: led, module: "led", params: { color: "blue" } });
      signal(board(io), pin(button, "1"), pin(led, "K"));
      ground.push(pin(button, "3"));
      power.push(pin(led, "A"));
      roles.push({ pin: io, mode: "INPUT_PULLUP", part: button, purpose: "key" });
      return true;
    },
    pot() {
      const [pot, io] = [next("POT"), analog.pop()];
      if (!io) return false;
      parts.push({ id: pot, module: "potentiometer", params: { ohms: 10000 } });
      power.push(pin(pot, "A"));
      ground.push(pin(pot, "B"));
      signal(board(io), pin(pot, "W"));
      roles.push({ pin: io, mode: "ANALOG_IN", part: pot, purpose: "knob" });
      return true;
    },
    divider() {
      const [sensor, resistor, io] = [next("LDR"), next("R"), analog.pop()];
      if (!io) return false;
      parts.push({ id: sensor, module: "photoresistor", params: {} }, { id: resistor, module: "resistor", params: { ohms: 10000 } });
      power.push(pin(sensor, "1"));
      signal(board(io), pin(sensor, "2"), pin(resistor, "1"));
      ground.push(pin(resistor, "2"));
      roles.push({ pin: io, mode: "ANALOG_IN", part: sensor, purpose: "light" });
      return true;
    },
    speaker() {
      const [buzzer, resistor, io] = [next("BZ"), next("R"), digital.pop()];
      if (!io) return false;
      parts.push({ id: buzzer, module: "buzzer-passive", params: {} }, { id: resistor, module: "resistor", params: { ohms: 1000 } });
      signal(board(io), pin(resistor, "1"));
      signal(pin(resistor, "2"), pin(buzzer, "P"));
      ground.push(pin(buzzer, "N"));
      roles.push({ pin: io, mode: "OUTPUT", part: buzzer, purpose: "tone" });
      return true;
    },
    sharedResistor() {
      const resistor = next("R");
      const cathodes: Ref[] = [];
      const leds: typeof parts = [];
      for (let index = 0; index < 3; index += 1) {
        const io = digital.pop();
        if (!io) break;
        const led = next("LED");
        leds.push({ id: led, module: "led", params: { color: "yellow" } });
        signal(board(io), pin(led, "A"));
        cathodes.push(pin(led, "K"));
        roles.push({ pin: io, mode: "OUTPUT", part: led, purpose: "light" });
      }
      if (cathodes.length === 0) return false;
      parts.push({ id: resistor, module: "resistor", params: { ohms: 220 } }, ...leds);
      signal(...cathodes, pin(resistor, "1"));
      ground.push(pin(resistor, "2"));
      return true;
    },
    sensor() {
      const module = next("U");
      const ios = [digital.pop(), random() < 0.5 ? analog.pop() : undefined].filter((io): io is string => io !== undefined);
      if (ios.length === 0) return false;
      parts.push({
        id: module,
        module: "generic",
        label: "Sensor module",
        params: { role: "digital-sensor", description: "Sensor" },
        pinout: [{ id: "VCC", name: "VCC", etype: "power_in" }, { id: "GND", name: "GND", etype: "power_in" }, ...ios.map((_, index) => ({ id: `OUT${index}`, name: `out ${index}`, etype: "output" })), { id: "NC", name: "not connected", etype: "passive" }],
      });
      power.push(pin(module, "VCC"));
      ground.push(pin(module, "GND"));
      ios.forEach((io, index) => {
        signal(board(io), pin(module, `OUT${index}`));
        roles.push({ pin: io, mode: io.startsWith("A") ? "ANALOG_IN" : "INPUT", part: module, purpose: "sense" });
      });
      return true;
    },
  };
  const names = Object.keys(blocks);
  for (let tries = 0; tries < 30; tries += 1) {
    const snapshot = { parts: parts.length, nets: nets.length, roles: roles.length, ground: ground.length, power: power.length, counters: { ...counters } };
    if (!blocks[choose(names)]!()) continue;
    const signals = nets.length;
    if (parts.length > ENVELOPE.maxParts || signals > ENVELOPE.maxSignalNets) {
      parts.length = snapshot.parts;
      nets.length = snapshot.nets;
      roles.length = snapshot.roles;
      ground.length = snapshot.ground;
      power.length = snapshot.power;
      break;
    }
  }
  if (ground.length > 1) nets.push({ id: "GND", kind: "ground", pins: ground });
  if (power.length > 1) nets.push({ id: "5V", kind: "power", pins: power });
  return circuitOf({ parts, nets, roles });
}

describe("allocator realizes every net (issue #13)", () => {
  it("lays out the mini piano rev 4: pin → resistor → passive buzzer", () => {
    const circuit = piano(false);
    const layout = assertBuildable(circuit);
    // The resistor→buzzer net is joined on the board, not only resistor→LED pairs.
    expect(lvs(circuit, layout).netMap.SPK).toBeDefined();
  });

  it("lays out the mini piano rev 5: LED cathodes share the key nets, one resistor feeds all anodes", () => {
    assertBuildable(piano(true));
    assertBuildable({ ...piano(true), breadboard: { profile: "bb-400" } });
  });

  it("joins a net of several parts and a board pin", () => {
    assertBuildable(circuitOf({
      parts: [
        { id: "R1", module: "resistor", params: { ohms: 220 } },
        { id: "R2", module: "resistor", params: { ohms: 220 } },
        { id: "LED1", module: "led", params: { color: "red" } },
        { id: "LED2", module: "led", params: { color: "green" } },
        { id: "BZ1", module: "buzzer-active", params: {} },
      ],
      nets: [
        { id: "D7", kind: "signal", pins: [board("D7"), pin("R1", "1"), pin("R2", "1"), pin("BZ1", "P")] },
        { id: "L1", kind: "signal", pins: [pin("R1", "2"), pin("LED1", "A")] },
        { id: "L2", kind: "signal", pins: [pin("R2", "2"), pin("LED2", "A")] },
        { id: "GND", kind: "ground", pins: [board("GND"), pin("LED1", "K"), pin("LED2", "K"), pin("BZ1", "N")] },
      ],
      roles: [{ pin: "D7", mode: "OUTPUT", part: "BZ1", purpose: "alarm" }],
    }));
  });

  it("joins a pure part-to-part chain: pin → R → R → LED", () => {
    assertBuildable(circuitOf({
      parts: [
        { id: "R1", module: "resistor", params: { ohms: 100 } },
        { id: "R2", module: "resistor", params: { ohms: 120 } },
        { id: "LED1", module: "led", params: { color: "white" } },
      ],
      nets: [
        { id: "D9", kind: "signal", pins: [board("D9"), pin("R1", "1")] },
        { id: "M1", kind: "signal", pins: [pin("R1", "2"), pin("R2", "1")] },
        { id: "M2", kind: "signal", pins: [pin("R2", "2"), pin("LED1", "A")] },
        { id: "GND", kind: "ground", pins: [board("GND"), pin("LED1", "K")] },
      ],
      roles: [{ pin: "D9", mode: "PWM_OUT", part: "LED1", purpose: "light" }],
    }));
  });

  it("keeps random valid circuits inside the envelope LVS-clean", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const circuit = randomCircuit(seed);
      expect(validateCircuit(circuit).filter((issue) => issue.severity === "error"), `seed ${seed}`).toEqual([]);
      const layout = layoutBoard(circuit);
      expect(lvs(circuit, layout).issues.filter((issue) => issue.severity === "error"), `seed ${seed}`).toEqual([]);
    }
  }, 240_000); // 40 full allocator runs: ~7 s alone, ~25 s when other suites share the CPU.

  it("reports a circuit that cannot physically fit as a tool-side finding", () => {
    const keys = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A0", "A1"];
    const crowded = circuitOf({
      breadboard: "bb-400",
      parts: keys.map((_, index) => ({ id: `BTN${index + 1}`, module: "button", params: {} })),
      nets: [
        ...keys.map((io, index) => ({ id: io, kind: "signal", pins: [board(io), pin(`BTN${index + 1}`, "1")] })),
        { id: "GND", kind: "ground", pins: [board("GND"), ...keys.map((_, index) => pin(`BTN${index + 1}`, "3"))] },
      ],
      roles: keys.map((io, index) => ({ pin: io, mode: "INPUT_PULLUP", part: `BTN${index + 1}`, purpose: "key" })),
    });
    let caught: unknown;
    try {
      layoutBoard(crowded);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LayoutFitError);
    const report = layoutFailureReport({ error: caught as LayoutFitError, revisionHash: "test" });
    expect(report.verdict).toBe("NO-GO");
    expect(report.findings[0]).toMatchObject({ ruleId: "LAYOUT-NO-FIT", toolSide: true });
    // The same circuit fits the full-size board.
    assertBuildable({ ...crowded, breadboard: { profile: "bb-830" } });
  });

  it("reports a self-contradicting design as a design finding, not a tool one", () => {
    const contradictory = circuitOf({
      parts: [{ id: "BTN1", module: "button", params: {} }],
      nets: [
        { id: "D2", kind: "signal", pins: [board("D2"), pin("BTN1", "1")] },
        { id: "D3", kind: "signal", pins: [board("D3"), pin("BTN1", "2")] },
        { id: "GND", kind: "ground", pins: [board("GND"), pin("BTN1", "3")] },
      ],
      roles: [{ pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "key" }],
    });
    expect(() => layoutBoard(contradictory)).toThrow(LayoutFitError);
    try {
      layoutBoard(contradictory);
    } catch (error) {
      expect((error as LayoutFitError).toolSide).toBe(false);
      expect(layoutFailureReport({ error: error as LayoutFitError, revisionHash: "test" }).findings[0]?.toolSide).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #16: "put each light next to its button" must be built, or reported as not built.

/** The whack-a-mole from issue #16: buttons D2–D4, LEDs D8–D10 through 1 kΩ, optionally grouped button+R+LED. */
function whackAMole(options: { groups?: boolean; breadboard?: "bb-830" | "bb-400" } = {}): Circuit {
  const moles = [1, 2, 3];
  return circuitOf({
    breadboard: options.breadboard,
    parts: [
      ...moles.map((i) => ({ id: `BTN${i}`, module: "button", params: {} })),
      ...moles.map((i) => ({ id: `R${i}`, module: "resistor", params: { ohms: 1000 } })),
      ...moles.map((i) => ({ id: `LED${i}`, module: "led", params: { color: ["red", "yellow", "green"][i - 1] } })),
    ],
    nets: [
      { id: "GND", kind: "ground", pins: [board("GND"), ...moles.map((i) => pin(`BTN${i}`, "3")), ...moles.map((i) => pin(`LED${i}`, "K"))] },
      ...moles.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1")] })),
      ...moles.map((i) => ({ id: `D${i + 7}`, kind: "signal", pins: [board(`D${i + 7}`), pin(`R${i}`, "1")] })),
      ...moles.map((i) => ({ id: `L${i}`, kind: "signal", pins: [pin(`R${i}`, "2"), pin(`LED${i}`, "A")] })),
    ],
    roles: [
      ...moles.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: `Button ${i}` })),
      ...moles.map((i) => ({ pin: `D${i + 7}`, mode: "OUTPUT", part: `LED${i}`, purpose: `Mole ${i}` })),
    ],
    ...(options.groups ? { placement: { groups: moles.map((i) => [`BTN${i}`, `R${i}`, `LED${i}`]) } } : {}),
  });
}

/** Rows and board halves of a placed part, straight from its holes. */
function where(layout: Layout, part: string): { from: number; to: number; halves: Set<string> } {
  // Terminal holes only: a leg straight in a rail hole is on neither half.
  const holes = Object.values(layout.placements.find((placement) => placement.part === part)!.pins).map((hole) => parseHole(hole)!).filter((hole) => hole.kind === "terminal");
  const rows = holes.map((hole) => (hole.kind === "terminal" ? hole.row : 0));
  return { from: Math.min(...rows), to: Math.max(...rows), halves: new Set(holes.map((hole) => (hole.kind === "terminal" && "abcde".includes(hole.column) ? "top" : "bottom"))) };
}

describe("placement groups (issue #16)", () => {
  it.each(["bb-830", "bb-400"] as const)("puts each light and its resistor next to its button on %s, groups in pin order", (breadboard) => {
    const circuit = whackAMole({ groups: true, breadboard });
    const layout = assertBuildable(circuit);
    let previousEnd = 0;
    // Groups in pin order (mole 1 on D2/D8 leftmost); the Uno faces whichever way makes the wires run parallel.
    for (const i of [1, 2, 3]) {
      const button = where(layout, `BTN${i}`);
      const led = where(layout, `LED${i}`);
      const resistor = where(layout, `R${i}`);
      // Within 4 rows of the button's rows; LED and resistor never on opposite halves (a part across the channel sits
      // on both).
      for (const part of [led, resistor]) expect(Math.max(part.from - button.to, button.from - part.to, 0), `mole ${i}`).toBeLessThanOrEqual(4);
      const oneHalf = [led, resistor].filter((part) => part.halves.size === 1).map((part) => [...part.halves][0]);
      expect(new Set(oneHalf).size, `mole ${i} halves`).toBeLessThanOrEqual(1);
      const start = Math.min(button.from, led.from, resistor.from);
      expect(start, `group ${i} starts right of the group before it`).toBeGreaterThan(previousEnd);
      previousEnd = Math.max(button.to, led.to, resistor.to);
    }
    const report = assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" });
    expect(report.findings.some((finding) => finding.ruleId === "PLACEMENT-UNMET")).toBe(false);
    expect(placementSummary(circuit, layout).groups.map((group) => group.met)).toEqual([true, true, true]);
  });

  it("leaves designs without groups as they were: no placement findings, nothing reported as grouped", () => {
    const circuit = whackAMole();
    const layout = assertBuildable(circuit);
    const report = assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" });
    expect(report.findings.some((finding) => finding.ruleId === "PLACEMENT-UNMET")).toBe(false);
    expect(placementSummary(circuit, layout).groups).toEqual([]);
    expect(placementSummary(circuit, layout).parts.map((entry) => entry.part).sort()).toEqual(circuit.parts.map((part) => part.id).sort());
  });

  it("fails a group it cannot build (PLACEMENT-UNMET, tool-side NO-GO) and still lays the circuit out", () => {
    const keys = [1, 2, 3, 4, 5, 6];
    const circuit = circuitOf({
      parts: [...keys.map((i) => ({ id: `BTN${i}`, module: "button", params: {} })), { id: "LED1", module: "led", params: { color: "red" } }, { id: "R1", module: "resistor", params: { ohms: 220 } }],
      nets: [
        ...keys.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1")] })),
        { id: "D9", kind: "signal", pins: [board("D9"), pin("R1", "1")] },
        { id: "L1", kind: "signal", pins: [pin("R1", "2"), pin("LED1", "A")] },
        { id: "GND", kind: "ground", pins: [board("GND"), pin("LED1", "K"), ...keys.map((i) => pin(`BTN${i}`, "3"))] },
      ],
      roles: [...keys.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: "key" })), { pin: "D9", mode: "OUTPUT", part: "LED1", purpose: "light" }],
      // Six buttons cannot all sit within 4 rows of the light listed first.
      placement: { groups: [["LED1", ...keys.map((i) => `BTN${i}`)]] },
    });
    const layout = layoutBoard(circuit);
    const result = lvs(circuit, layout);
    expect(result.ok).toBe(true);
    const report = assemblyReport({ circuit, layout, lvs: result, revisionHash: "test" });
    const unmet = report.findings.filter((finding) => finding.ruleId === "PLACEMENT-UNMET");
    expect(unmet).toHaveLength(1);
    expect(unmet[0]).toMatchObject({ toolSide: true, severity: "error", refs: { parts: ["LED1", ...keys.map((i) => `BTN${i}`)] } });
    expect(unmet[0]!.detail).toMatch(/rows away from LED1/);
    expect(report.verdict).toBe("NO-GO");
    expect((report.evidence?.placement as { groups: { met: boolean }[] }).groups[0]!.met).toBe(false);
  });

  it("rejects placement groups naming unknown parts or a part twice", () => {
    const base = whackAMole();
    const unknown = parseCircuit({ ...base, placement: { groups: [["BTN1", "LED9"]] } });
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.map((issue) => issue.code)).toContain("IR-PLACEMENT");
    const twice = parseCircuit({ ...base, placement: { groups: [["BTN1", "LED1"], ["BTN2", "LED1"]] } });
    expect(twice.issues.filter((issue) => issue.code === "IR-PLACEMENT")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #18: the rails step and its picture show exactly the rail wires the layout has, and the power checkpoint
// claims only what rails.vcc measures (the Arduino's own USB supply).

describe("rails step and power checkpoint (issue #18)", () => {
  it.each(GOLDEN.map((design) => [design.key, design.circuit] as const))("%s: text and picture list exactly the layout's rail wires", (_key, circuit) => {
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    const rails = steps.steps.find((step) => step.kind === "rails")!;
    const onRail = (end: Layout["jumpers"][number]["from"]) => "hole" in end && /^[TB][+-]/.test(end.hole);
    const expected = layout.jumpers.filter((jumper) => ("board" in jumper.from && onRail(jumper.to)) || ("board" in jumper.to && onRail(jumper.from)));
    expect(rails.adds.jumpers).toEqual(expected.map((jumper) => jumper.id));
    const usesPower = circuit.nets.some((net) => net.kind === "power" && net.pins.some((ref) => ref.part === "board" && ref.pin === "5V") && net.pins.some((ref) => ref.part !== "board"));
    expect(expected.some((jumper) => "hole" in jumper.to && jumper.to.hole.startsWith("T+"))).toBe(usesPower);
    for (const jumper of expected) {
      expect(rails.text).toContain(`Arduino pin ${"board" in jumper.from ? jumper.from.board : ""} (`);
      expect(rails.text).toContain(`→ hole ${"hole" in jumper.to ? jumper.to.hole : ""} on the`);
    }
    if (usesPower) expect(rails.text).toContain("Both top rails are used.");
    else expect(rails.text).toContain("Only the blue − rail (GND) is used in this build");
    // The picture for this step draws each of those wires, and no other.
    const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: rails.n });
    const drawn = [...svg.matchAll(/<g id="wire-(W\d+)"/g)].map((match) => match[1]);
    expect(drawn.sort()).toEqual(expected.map((jumper) => jumper.id).sort());
  });

  it("claims only a board power check at the checkpoint, never a rail check", () => {
    for (const design of GOLDEN) {
      const steps = buildSteps(design.circuit, layoutBoard(design.circuit));
      const checkpoint = steps.steps.find((step) => step.checkpoint?.tests.includes("rails.vcc") && step.kind === "checkpoint" && step.title.startsWith("Power checkpoint"))!;
      for (const text of [checkpoint.text, checkpoint.checkpoint!.text]) {
        expect(text).toContain("USB VCC");
        expect(text).not.toMatch(/inspect T\+|checks that the red \+ rail|rails? (has|have) 5 V/);
        expect(text).toMatch(/checked by the part tests that follow/);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #24: the bare Arduino is connected, flashed with the safe firmware and power-checked before anything goes on
// the breadboard.

describe("bare-board check first (issue #24)", () => {
  it.each(GOLDEN.map((design) => [design.key, design.circuit] as const))("%s: the bare-board check comes before the first part or wire", (_key, circuit) => {
    const steps = buildSteps(circuit, layoutBoard(circuit)).steps;
    const bare = steps.findIndex((step) => step.title.startsWith("Bare-board check"));
    const firstBuild = steps.findIndex((step) => step.adds.parts.length > 0 || step.adds.jumpers.length > 0);
    expect(bare).toBeGreaterThanOrEqual(0);
    expect(bare).toBeLessThan(firstBuild);
    expect(steps[bare]).toMatchObject({ kind: "checkpoint", plug: "plugged", adds: { parts: [], jumpers: [] }, checkpoint: { tests: ["rails.vcc"] } });
    // It is unplugged again before the first wire goes in.
    expect(steps.slice(bare + 1, firstBuild).some((step) => step.kind === "unplug")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #19: every jumper is drawn as a visible wire whatever its length, and its step label never hides it.

type Pt2 = { x: number; y: number };

/** Points along an SVG path made of M / Q / C commands (what renderJumper emits). */
function samplePath(d: string): Pt2[] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const commands = d.match(/[MQC]/g) ?? [];
  const points: Pt2[] = [];
  let index = 0;
  let current: Pt2 = { x: 0, y: 0 };
  const take = (): Pt2 => ({ x: numbers[index++]!, y: numbers[index++]! });
  for (const command of commands) {
    if (command === "M") {
      current = take();
      points.push(current);
    } else if (command === "Q") {
      const [c, end] = [take(), take()];
      for (let t = 0.05; t <= 1.0001; t += 0.05) points.push({ x: (1 - t) ** 2 * current.x + 2 * (1 - t) * t * c.x + t * t * end.x, y: (1 - t) ** 2 * current.y + 2 * (1 - t) * t * c.y + t * t * end.y });
      current = end;
    } else {
      const [c1, c2, end] = [take(), take(), take()];
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const u = 1 - t;
        points.push({ x: u ** 3 * current.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x, y: u ** 3 * current.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y });
      }
      current = end;
    }
  }
  return points;
}

/** Checks every jumper drawn in `svg`: a real path, visibly long, not covered by its label. Returns the ids seen. */
function assertJumpersVisible(svg: string, context: string): string[] {
  const seen: string[] = [];
  for (const match of svg.matchAll(/<g id="wire-(W\d+)"[^>]*>([\s\S]*?)<\/g>/g)) {
    const [, id, body] = match;
    const d = body!.match(/<path d="([^"]+)" stroke="[^"]+" class="wire-path"/)?.[1];
    expect(d, `${context} ${id}: coloured wire path`).toBeDefined();
    const points = samplePath(d!);
    let length = 0;
    for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    // At least ~2 hole pitches of drawn wire, and it rises clear of the hole markers (radius 5) somewhere.
    expect(length, `${context} ${id}: drawn length`).toBeGreaterThan(30);
    const [start, end] = [points[0]!, points.at(-1)!];
    const farthest = Math.max(...points.map((point) => Math.min(Math.hypot(point.x - start.x, point.y - start.y), Math.hypot(point.x - end.x, point.y - end.y))));
    expect(farthest, `${context} ${id}: wire leaves its holes`).toBeGreaterThan(12);
    const tag = svg.match(new RegExp(`data-jumper-label="${id}"><rect x="([\\d.-]+)" y="([\\d.-]+)" width="([\\d.]+)" height="([\\d.]+)"`));
    if (tag) {
      const [x, y, w, h] = tag.slice(1).map(Number) as [number, number, number, number];
      const inside = (point: Pt2, pad: number) => point.x > x - pad && point.x < x + w + pad && point.y > y - pad && point.y < y + h + pad;
      expect(inside(start, 6) || inside(end, 6), `${context} ${id}: label covers an end`).toBe(false);
      expect(points.filter((point) => inside(point, 0)).length / points.length, `${context} ${id}: label covers the wire`).toBeLessThan(0.2);
    }
    seen.push(id!);
  }
  return seen;
}

/** Five LEDs on D2–D6 with resistors, the design from issue #19. */
function binaryCounter(): Circuit {
  const bits = [1, 2, 3, 4, 5];
  return circuitOf({
    parts: [...bits.map((i) => ({ id: `LED${i}`, module: "led", params: { color: "red" } })), ...bits.map((i) => ({ id: `R${i}`, module: "resistor", params: { ohms: 220 } }))],
    nets: [
      { id: "GND", kind: "ground", pins: [board("GND"), ...bits.map((i) => pin(`LED${i}`, "K"))] },
      ...bits.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`R${i}`, "1")] })),
      ...bits.map((i) => ({ id: `L${i}`, kind: "signal", pins: [pin(`R${i}`, "2"), pin(`LED${i}`, "A")] })),
    ],
    roles: bits.map((i) => ({ pin: `D${i + 1}`, mode: "OUTPUT", part: `LED${i}`, purpose: `bit ${i}` })),
  });
}

describe("jumper drawings (issue #19)", () => {
  const designs: [string, Circuit][] = [
    ...GOLDEN.map((design) => [design.key, design.circuit] as [string, Circuit]),
    ["piano-rev4", piano(false)],
    ["piano-rev5", piano(true)],
    ["whack-a-mole", whackAMole({ groups: true })],
    ["binary-counter", binaryCounter()],
  ];

  it.each(designs)("%s: every step's new wires and the finished board draw every jumper visibly", (key, circuit) => {
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    expect(assertJumpersVisible(renderBreadboardSvg({ circuit, layout, steps }), `${key} board`).sort()).toEqual(layout.jumpers.map((jumper) => jumper.id).sort());
    for (const step of steps.steps.filter((entry) => entry.adds.jumpers.length > 0)) {
      for (const focus of [false, true]) {
        const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: step.n, focus });
        const seen = assertJumpersVisible(svg, `${key} step ${step.n}${focus ? " focus" : ""}`);
        for (const id of step.adds.jumpers) {
          expect(seen, `${key} step ${step.n}`).toContain(id);
          expect(svg, `${key} step ${step.n}: ${id} labelled`).toContain(`data-jumper-label="${id}"`);
          // The step's own wires are drawn after (on top of) the parts.
          expect(svg.indexOf(`id="wire-${id}"`)).toBeGreaterThan(svg.lastIndexOf('<g id="part-'));
        }
      }
    }
  });

  it("draws the issue's same-row two-hole jumper (a11 → a9) as a visible arc with its label beside it", () => {
    const circuit = binaryCounter();
    const base = layoutBoard(circuit);
    const layout: Layout = { ...base, jumpers: [...base.jumpers, { id: "W99", from: { hole: "a11" }, to: { hole: "a9" }, color: "yellow", net: "L1" }] };
    const steps = buildSteps(circuit, layout);
    const step = steps.steps.find((entry) => entry.adds.jumpers.includes("W99"))!;
    for (const focus of [false, true]) expect(assertJumpersVisible(renderBreadboardSvg({ circuit, layout, steps, upToStep: step.n, focus }), `a11→a9${focus ? " focus" : ""}`)).toContain("W99");
    // Also a jumper whose two ends are in the same strip column (vertical hop) and a zero-length one.
    const hop: Layout = { ...base, jumpers: [...base.jumpers, { id: "W98", from: { hole: "c40" }, to: { hole: "e40" }, color: "blue", net: "L2" }] };
    const hopSteps = buildSteps(circuit, hop);
    const hopStep = hopSteps.steps.find((entry) => entry.adds.jumpers.includes("W98"))!;
    expect(assertJumpersVisible(renderBreadboardSvg({ circuit, layout: hop, steps: hopSteps, upToStep: hopStep.n }), "c40→e40")).toContain("W98");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #22: LEGO-style steps. Every new part gets a "parts for this step" panel, every wire's two ends are named and
// badged 1/2, and placements are anchored to something already on the board, each landmark provably true.

describe("LEGO-style build steps (issue #22)", () => {
  const designs: [string, Circuit][] = [
    ...GOLDEN.map((design) => [design.key, design.circuit] as [string, Circuit]),
    ["piano-rev4", piano(false)],
    ["piano-rev5", piano(true)],
    ["whack-a-mole", whackAMole({ groups: true })],
    ["binary-counter", binaryCounter()],
  ];
  const endName = (end: Layout["jumpers"][number]["from"]) => ("board" in end ? `Arduino pin ${end.board}` : `hole ${end.hole}`);
  const endAt = (end: Layout["jumpers"][number]["from"]) => ("board" in end ? `board:${end.board}` : end.hole);

  it.each(designs)("%s: every LED step previews its legs, anode and cathode on the side of their own holes", (key, circuit) => {
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    for (const part of circuit.parts.filter((entry) => entry.module === "led")) {
      const step = steps.steps.find((entry) => entry.adds.parts.includes(part.id))!;
      // A repeat step's LEDs are copies of the one previewed on the template step (checked there); it shows the checklist.
      if (step.repeat?.role === "repeat") {
        expect(steps.steps[step.repeat.template - 1]!.adds.parts.some((id) => circuit.parts.find((entry) => entry.id === id)?.module === "led")).toBe(true);
        continue;
      }
      const pins = layout.placements.find((entry) => entry.part === part.id)!.pins;
      for (const focus of [false, true]) {
        const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: step.n, focus });
        const panel = svg.match(new RegExp(`<g data-panel-part="${part.id}">[\\s\\S]*?</g></g>`))?.[0];
        expect(panel, `${key} ${part.id}${focus ? " focus" : ""}: panel`).toBeDefined();
        const x = (pattern: string) => Number(panel!.match(new RegExp(`<text x="([\\d.-]+)"[^>]*>${pattern}</text>`))?.[1]);
        const anodeHole = x(pins.A!);
        const cathodeHole = x(pins.K!);
        const middle = (anodeHole + cathodeHole) / 2;
        for (const value of [anodeHole, cathodeHole, x("\\+ anode"), x("− cathode")]) expect(Number.isFinite(value), `${key} ${part.id}: panel text found`).toBe(true);
        // The anode's words sit on the anode leg's side, the cathode's on the cathode's, and the long leg is the anode.
        expect(Math.sign(x("\\+ anode") - middle), `${key} ${part.id}: + anode side`).toBe(Math.sign(anodeHole - middle));
        expect(Math.sign(x("− cathode") - middle), `${key} ${part.id}: − cathode side`).toBe(Math.sign(cathodeHole - middle));
        expect(panel).toContain("long leg");
        expect(panel).toContain("short leg, flat side");
        // The leg order in the panel matches the board: the leg further left on the board is further left in the panel
        // (an upright LED, both legs in one column, may be drawn either way).
        const column = (hole: string) => Number(hole.replace(/^\D+/, ""));
        if (column(pins.A!) !== column(pins.K!)) expect(Math.sign(anodeHole - cathodeHole)).toBe(Math.sign(column(pins.A!) - column(pins.K!)));
        // Arrows from the panel to the holes when the step adds one or two pieces (more would criss-cross the board).
        if (step.adds.parts.length + step.adds.jumpers.length <= 2) for (const hole of [pins.A!, pins.K!]) expect(svg, `${key} ${part.id}: arrow to ${hole}`).toContain(`data-arrow-hole="${hole}"`);
      }
    }
  });

  it.each(designs)("%s: every wire step names both ends in the text and badges them 1 and 2 on the picture", (key, circuit) => {
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    for (const step of steps.steps.filter((entry) => entry.adds.jumpers.length > 0)) {
      const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: step.n, focus: true });
      expect(step.wireEnds?.map((entry) => entry.jumper), `${key} step ${step.n}`).toEqual(step.adds.jumpers);
      for (const { jumper: id, ends } of step.wireEnds!) {
        const jumper = layout.jumpers.find((entry) => entry.id === id)!;
        expect(ends.map((end) => [end.n, end.at])).toEqual([[1, endAt(jumper.from)], [2, endAt(jumper.to)]]);
        for (const end of [jumper.from, jumper.to]) expect(step.text, `${key} step ${step.n}: ${id}`).toContain(endName(end));
        if (step.kind === "jumper") expect(step.text).toMatch(new RegExp(`End 1: ${endName(jumper.from).replace(/[+]/g, "\\+")}[^.]*\\. End 2: ${endName(jumper.to).replace(/[+]/g, "\\+")}`));
        for (const n of [1, 2]) expect(svg, `${key} step ${step.n}: badge ${id}:${n}`).toContain(`data-wire-end="${id}:${n}"`);
        // Badge 2 sits exactly on the hole it names; badge 1 on a header pin sits beside the pin, clear of its name.
        if ("hole" in jumper.to) {
          const hole = svg.match(new RegExp(`id="hole-${jumper.to.hole.replace(/[+]/g, "\\+")}" cx="([\\d.]+)" cy="([\\d.]+)"`))!;
          const badge = svg.match(new RegExp(`data-wire-end="${id}:2"><circle cx="([\\d.]+)" cy="([\\d.]+)"`))!;
          expect(Number(badge[1])).toBeCloseTo(Number(hole[1]), 0);
          expect(Number(badge[2])).toBeCloseTo(Number(hole[2]), 0);
        }
        if ("board" in jumper.from) {
          const pin = svg.match(new RegExp(`<g id="pin-${jumper.from.board}"><circle cx="([\\d.]+)" cy="([\\d.]+)"[^>]*/><text x="([\\d.]+)" y="([\\d.]+)"`))!.slice(1).map(Number) as [number, number, number, number];
          const [x, y] = svg.match(new RegExp(`data-wire-end="${id}:1"><circle cx="([\\d.]+)" cy="([\\d.]+)" r="11"`))!.slice(1).map(Number) as [number, number];
          expect(Math.hypot(x - pin[0], y - pin[1]), `${key} step ${step.n}: badge ${id}:1 at its pin`).toBeLessThan(20);
          // The name's box (11 px text, up to 3 characters) and the badge's circle (radius 11 plus its stroke) don't touch.
          const [left, right, top, bottom] = [pin[2] - 12, pin[2] + 12, pin[3] - 10, pin[3] + 2];
          const gap = Math.hypot(x - Math.max(left, Math.min(x, right)), y - Math.max(top, Math.min(y, bottom)));
          expect(gap, `${key} step ${step.n}: badge ${id}:1 covers the name ${jumper.from.board}`).toBeGreaterThan(12);
        }
      }
    }
  });

  it("every landmark is true, refers to something already built, and is what the text says; ≥90% of placements have one", () => {
    let placements = 0;
    let anchored = 0;
    for (const [key, circuit] of designs) {
      const layout = layoutBoard(circuit);
      const steps = buildSteps(circuit, layout);
      const built = new Set<string>();
      for (const step of steps.steps) {
        for (const landmark of step.landmarks ?? []) {
          expect(landmarkHolds(layout, landmark), `${key} step ${step.n}: ${landmark.text}`).toBe(true);
          expect(step.text, `${key} step ${step.n}`).toContain(landmark.text);
          if (landmark.kind !== "header") {
            // Something already on the board, or placed earlier in this same step (a unit step's LED next to its resistor).
            const ref = "part" in landmark.ref ? landmark.ref.part : landmark.ref.jumper;
            expect(built.has(ref) || step.adds.parts.includes(ref) || step.adds.jumpers.includes(ref), `${key} step ${step.n}: ${ref} built before`).toBe(true);
          }
        }
        if (step.kind === "place" || step.kind === "jumper") {
          placements += 1;
          if ((step.landmarks ?? []).some((landmark) => landmark.kind !== "header")) anchored += 1;
        }
        for (const id of [...step.adds.parts, ...step.adds.jumpers]) built.add(id);
      }
    }
    expect(anchored / placements).toBeGreaterThanOrEqual(0.9);
  });

  // resvg panics (SIGABRT, no error) on some drawings, which crashes the pipeline's picture stage and turns FAO NO-GO.
  it.each(designs)("%s: every step picture, whole and focused, rasterizes to PNG", async (_key, circuit) => {
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    for (const step of steps.steps) {
      const view = { circuit, layout, steps, upToStep: step.n, highlight: { holes: step.holes, parts: step.adds.parts, jumpers: step.adds.jumpers } };
      for (const focus of [false, true]) {
        const png = await svgToPng(renderBreadboardSvg({ ...view, focus }), 600);
        expect(Buffer.from(png.subarray(1, 4)).toString(), `step ${step.n}${focus ? " focus" : ""}`).toBe("PNG");
      }
    }
  }, 60_000);

  it("a landmark that no longer matches the layout is caught", () => {
    const circuit = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(circuit);
    const landmark = buildSteps(circuit, layout).steps.flatMap((step) => step.landmarks ?? []).find((entry): entry is Exclude<typeof entry, { kind: "header" }> => entry.kind === "same-strip")!;
    expect(landmarkHolds(layout, landmark)).toBe(true);
    const moved = parseHole(landmark.hole)!;
    expect(moved.kind).toBe("terminal");
    if (moved.kind === "terminal") expect(landmarkHolds(layout, { ...landmark, hole: `${moved.column}${moved.row + 1}` })).toBe(false);
    expect(landmarkHolds(layout, { kind: "header", pin: "D2", neighbours: ["D5"], text: "between D5" })).toBe(false);
  });

  it("draws new pieces at full strength and earlier ones dimmed", () => {
    const circuit = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    const step = steps.steps.filter((entry) => entry.kind === "place")[2]!;
    const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: step.n });
    const earlier = steps.steps.filter((entry) => entry.n < step.n).flatMap((entry) => entry.adds.parts);
    expect(svg).toMatch(new RegExp(`<g id="part-${step.adds.parts[0]}" class="part vb-new"`));
    for (const id of earlier) expect(svg).toMatch(new RegExp(`<g id="part-${id}" class="part vb-old"`));
  });

  it("uses one vocabulary: numbered columns, lettered rows, in the text and the picture key", () => {
    const circuit = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(circuit);
    const steps = buildSteps(circuit, layout);
    expect(steps.steps[1].text).toContain("Columns 1–63 run left to right; rows a–e are above the centre channel");
    const svg = renderBreadboardSvg({ circuit, layout, steps, upToStep: 7 });
    expect(svg).toContain("Columns 1–63 left → right");
    expect(svg).not.toMatch(/Rows left|Rows run left/);
  });

  it("draws a mini board without rails and a split-rail board with its gap bridged in the rails step", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const mini = { ...moon, breadboard: { profile: "bb-170" as const } };
    const miniLayout = layoutBoard(mini);
    const miniSteps = buildSteps(mini, miniLayout);
    expect(miniSteps.steps.find((step) => step.kind === "rails")!.title).toBe("No power rails on this board");
    expect(miniSteps.steps[1].text).toContain("This board has no power rails.");
    const miniSvg = renderBreadboardSvg({ circuit: mini, layout: miniLayout, steps: miniSteps });
    expect(miniSvg).not.toMatch(/class="rail-(plus|minus|hole)/);

    const split = { ...moon, breadboard: { profile: "bb-830-split" as const } };
    const splitLayout = layoutBoard(split);
    const splitSteps = buildSteps(split, splitLayout);
    const rails = splitSteps.steps.find((step) => step.kind === "rails")!;
    const bridges = splitLayout.jumpers.filter((jumper) => "hole" in jumper.from && "hole" in jumper.to && /^T.30$/.test(jumper.from.hole) && /^T.32$/.test(jumper.to.hole));
    expect(bridges.length).toBeGreaterThan(0);
    for (const bridge of bridges) {
      expect(rails.adds.jumpers).toContain(bridge.id);
      expect(rails.text).toContain(`across the gap: end 1 in hole ${"hole" in bridge.from ? bridge.from.hole : ""}, end 2 in hole ${"hole" in bridge.to ? bridge.to.hole : ""}`);
    }
    // Only part-and-wire steps come after the rails; no bridge is left for later.
    expect(splitSteps.steps.filter((step) => step.kind === "jumper").flatMap((step) => step.adds.jumpers)).not.toEqual(expect.arrayContaining(bridges.map((bridge) => bridge.id)));
    const splitSvg = renderBreadboardSvg({ circuit: split, layout: splitLayout, steps: splitSteps, upToStep: rails.n });
    expect(splitSvg).toContain('class="rail-gap">gap</text>');
  });
});
