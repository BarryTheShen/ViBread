import { describe, expect, it } from "vitest";

import { GOLDEN } from "@vibread/fixtures";
import { CircuitSchema, ENVELOPE, parseCircuit, parseHole, validateCircuit, type Circuit, type Layout } from "@vibread/core";

import { LayoutFitError, assemblyReport, buildSteps, layoutBoard, layoutFailureReport, layoutHash, lvs, placementSummary } from "./index.js";
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
    expect(steps.steps.slice(0, 6).map((step) => step.kind)).toEqual(["inventory", "orientation", "unplug", "rails", "checkpoint", "unplug"]);
    expect(steps.steps[4].plug).toBe("plugged");
    expect(steps.steps[4].checkpoint?.tests).toEqual(["rails.vcc"]);
    expect(steps.steps[4].text).not.toContain("rails.vcc");
    // The rails step wires exactly the Arduino 5 V and GND headers to their rails.
    const railWires = steps.steps[3].adds.jumpers.map((id) => layout.jumpers.find((jumper) => jumper.id === id)!);
    expect(railWires.map((jumper) => ["board" in jumper.from ? jumper.from.board : "", "hole" in jumper.to ? jumper.to.hole[0] + jumper.to.hole[1] : ""]).sort()).toEqual([["5V", "T+"], ["GND", "T-"]]);
    expect(steps.steps.at(-1)?.kind).toBe("power-up");
    expect(steps.steps.at(-1)?.plug).toBe("plugged");

    expect(steps.steps[1].text).toContain("Rows run left to right");
    const resistorStep = steps.steps.find((step) => step.title.startsWith("Insert R1"))!;
    expect(resistorStep.text).toMatch(/220 Ω resistor R1 \(red-red-brown-gold\) from hole [a-j]\d+ to hole [a-j]\d+/);
    const a0 = layout.jumpers.find((jumper) => "board" in jumper.from && jumper.from.board === "A0")!;
    const jumperStep = steps.steps.find((step) => step.adds.jumpers.includes(a0.id))!;
    expect(jumperStep.text).toContain(`from Arduino A0 header pin to hole ${"hole" in a0.to ? a0.to.hole : ""}`);
    const half = { ...moon, breadboard: { profile: "bb-400" as const } };
    const halfLayout = layoutBoard(half);
    expect(lvs(half, halfLayout).ok).toBe(true);
  });
  it("focuses a step around every new hole", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(moon);
    const steps = buildSteps(moon, layout);
    const step = steps.steps[6];
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
  });

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
  const holes = Object.values(layout.placements.find((placement) => placement.part === part)!.pins).map((hole) => parseHole(hole)!);
  const rows = holes.map((hole) => (hole.kind === "terminal" ? hole.row : 0));
  return { from: Math.min(...rows), to: Math.max(...rows), halves: new Set(holes.map((hole) => (hole.kind === "terminal" && "abcde".includes(hole.column) ? "top" : "bottom"))) };
}

describe("placement groups (issue #16)", () => {
  it.each(["bb-830", "bb-400"] as const)("puts each light and its resistor next to its button on %s, groups left to right", (breadboard) => {
    const circuit = whackAMole({ groups: true, breadboard });
    const layout = assertBuildable(circuit);
    let previousEnd = 0;
    for (const i of [1, 2, 3]) {
      const button = where(layout, `BTN${i}`);
      const led = where(layout, `LED${i}`);
      const resistor = where(layout, `R${i}`);
      // Within 4 rows of the button's rows, one half of the board for LED and resistor.
      for (const part of [led, resistor]) expect(Math.max(part.from - button.to, button.from - part.to, 0), `mole ${i}`).toBeLessThanOrEqual(4);
      expect(led.halves.size).toBe(1);
      expect([...resistor.halves]).toEqual([...led.halves]);
      const start = Math.min(button.from, led.from, resistor.from);
      expect(start, `group ${i} starts right of group ${i - 1}`).toBeGreaterThan(previousEnd);
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

  it("reports a group it cannot build as PLACEMENT-UNMET (tool-side) and still lays the circuit out", () => {
    const keys = [1, 2, 3, 4, 5, 6];
    const circuit = circuitOf({
      parts: keys.map((i) => ({ id: `BTN${i}`, module: "button", params: {} })),
      nets: [
        ...keys.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1")] })),
        { id: "GND", kind: "ground", pins: [board("GND"), ...keys.map((i) => pin(`BTN${i}`, "3"))] },
      ],
      roles: keys.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: "key" })),
      // Six buttons cannot all sit within 4 rows of BTN1.
      placement: { groups: [keys.map((i) => `BTN${i}`)] },
    });
    const layout = assertBuildable(circuit);
    const report = assemblyReport({ circuit, layout, lvs: lvs(circuit, layout), revisionHash: "test" });
    const unmet = report.findings.filter((finding) => finding.ruleId === "PLACEMENT-UNMET");
    expect(unmet).toHaveLength(1);
    expect(unmet[0]).toMatchObject({ toolSide: true, severity: "warning", refs: { parts: keys.map((i) => `BTN${i}`) } });
    expect(unmet[0]!.title).toContain("BTN1, BTN2, BTN3, BTN4, BTN5, BTN6");
    expect(report.verdict).toBe("GO");
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
