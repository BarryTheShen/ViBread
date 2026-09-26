import { readFile, readdir } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { CircuitSchema, parseCircuit, type Circuit } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { checkSchematicSvg, checkTextLayout, parseSchematicSvg, type Pt } from "./check.js";
import { connectionRows, connectionTableSvg, verifiedSchematic } from "./fallback.js";
import { renderSchematicSvg } from "./index.js";

const FIXTURES = new URL("../../../../fixtures/", import.meta.url);

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

async function recordedCircuit(): Promise<Circuit> {
  const raw = JSON.parse(await readFile(new URL("recorded/moon-phase-lamp.2026-09-26.json", FIXTURES), "utf8")) as unknown;
  const steps = field(field(raw, "design"), "steps");
  const parsed = parseCircuit(field(field(Array.isArray(steps) ? steps[0] : undefined, "input"), "circuit"));
  if (!parsed.ok) throw new Error(`recorded circuit invalid: ${parsed.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.circuit;
}

/**
 * fixtures/schematic/*.json: the issue #1 dishwasher (4 resistors, and the shared-resistor variant the generated
 * design used) plus stress designs. They are parsed with the schema only (no envelope check): the renderer must draw
 * whatever it is given.
 */
async function schematicFixtures(): Promise<[string, Circuit][]> {
  const directory = new URL("schematic/", FIXTURES);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => [name.replace(/\.json$/, ""), CircuitSchema.parse(JSON.parse(await readFile(new URL(name, directory), "utf8")))] as [string, Circuit]));
}

const drawings = new Map<string, { circuit: Circuit; svg: string }>();

beforeAll(async () => {
  const all: [string, Circuit][] = [...GOLDEN.map((fixture) => [fixture.key, fixture.circuit] as [string, Circuit]), ["recorded-moon-phase-lamp", await recordedCircuit()], ...(await schematicFixtures())];
  for (const [key, circuit] of all) drawings.set(key, { circuit, svg: await renderSchematicSvg(circuit) });
}, 120_000);

function drawing(key: string): { circuit: Circuit; svg: string } {
  const entry = drawings.get(key);
  if (!entry) throw new Error(`no drawing for ${key}`);
  return entry;
}

function codes(svg: string, circuit: Circuit): string[] {
  return [...new Set(checkSchematicSvg(svg, circuit).map((issue) => issue.code))];
}

/** Move every coordinate of one top-level group (they are never nested). */
function shiftGroup(svg: string, opening: string, dx: number, dy: number): string {
  const start = svg.indexOf(opening);
  if (start < 0) throw new Error(`group ${opening} not found`);
  const end = svg.indexOf("</g>", start);
  const body = svg.slice(start, end).replace(/\b(x|x1|x2|cx|y|y1|y2|cy)="(-?[\d.]+)"/g, (_, name: string, value: string) => `${name}="${Number(value) + (name.startsWith("x") || name === "cx" ? dx : dy)}"`)
    .replace(/points="([^"]+)"/g, (_, points: string) => `points="${points.split(" ").map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return `${x! + dx},${y! + dy}`;
    }).join(" ")}"`);
  return svg.slice(0, start) + body + svg.slice(end);
}

function removeGroup(svg: string, opening: string): string {
  const start = svg.indexOf(opening);
  if (start < 0) throw new Error(`group ${opening} not found`);
  return svg.slice(0, start) + svg.slice(svg.indexOf("</g>", start) + 4);
}

function appendToNet(svg: string, net: string, element: string): string {
  const opening = `<g class="net" data-net="${net}">`;
  const start = svg.indexOf(opening);
  if (start < 0) throw new Error(`net ${net} not found`);
  return svg.slice(0, start + opening.length) + element + svg.slice(start + opening.length);
}

/** Midpoint of the net's longest horizontal wire. */
function wireMidpoint(svg: string, net: string): Pt {
  const wires = (parseSchematicSvg(svg).nets.get(net)?.wires ?? []).filter((wire) => wire.a.y === wire.b.y);
  const longest = [...wires].sort((a, b) => Math.abs(b.b.x - b.a.x) - Math.abs(a.b.x - a.a.x))[0];
  if (!longest) throw new Error(`net ${net} has no horizontal wires`);
  return { x: (longest.a.x + longest.b.x) / 2, y: longest.a.y };
}

describe("schematic drawings pass the geometry check", () => {
  const keys = [
    "moon-phase-lamp",
    "knob-night-light",
    "launch-control",
    "recorded-moon-phase-lamp",
    "dishwasher-panel",
    "dishwasher-shared-resistor",
    "six-led-chaser",
    "servo-knob-button",
    "dark-alarm",
    "distance-rgb",
  ];
  it.each(keys)("%s renders as a real, valid drawing (not the fallback)", (key) => {
    const { circuit, svg } = drawing(key);
    expect(svg).toContain('data-schematic="drawing"');
    expect(checkSchematicSvg(svg, circuit)).toEqual([]);
    const parsed = parseSchematicSvg(svg);
    for (const net of circuit.nets.filter((candidate) => candidate.kind === "signal")) expect(parsed.nets.get(net.id)?.wires.length, net.id).toBeGreaterThan(0);
  });

  it("covers every fixture in fixtures/schematic", async () => {
    for (const [key] of await schematicFixtures()) expect(keys).toContain(key);
  });
});

describe("the geometry check catches the issue #1 defects", () => {
  it("a resistor drawn away from its wires (detached)", () => {
    const { circuit, svg } = drawing("dishwasher-shared-resistor");
    expect(codes(shiftGroup(svg, '<g class="part" data-part="R1">', 0, 40), circuit)).toContain("SCH-NET-PIN-NOT-ON-WIRE");
  });

  it("a wire that stops short of its pin", () => {
    const { circuit, svg } = drawing("dishwasher-panel");
    const start = svg.indexOf('<g class="net" data-net="D9">');
    const points = svg.slice(start).match(/points="([^"]+)"/)![1]!;
    const pairs = points.split(" ");
    const [x, y] = pairs[pairs.length - 1]!.split(",").map(Number);
    const [px] = pairs[pairs.length - 2]!.split(",").map(Number);
    pairs[pairs.length - 1] = `${x! + Math.sign(px! - x!) * 12},${y}`;
    const broken = svg.slice(0, start) + svg.slice(start).replace(points, pairs.join(" "));
    expect(codes(broken, circuit)).toEqual(expect.arrayContaining(["SCH-NET-PIN-NOT-ON-WIRE", "SCH-NET-DANGLING"]));
  });

  it("part labels drawn on top of each other", () => {
    const { circuit, svg } = drawing("dishwasher-panel");
    const target = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>LED4<\/text>/)!;
    const moved = svg.replace(/<text x="[\d.]+" y="[\d.]+"([^>]*)>BZ1<\/text>/, `<text x="${target[1]}" y="${target[2]}"$1>BZ1</text>`);
    expect(codes(moved, circuit)).toContain("SCH-LABEL-OVERLAP");
  });

  it("a GND label drawn over a wire", () => {
    const { circuit, svg } = drawing("launch-control");
    const mid = wireMidpoint(svg, "D8");
    const moved = svg.replace(/(<g class="power" data-net="GND" data-pin="LED3.K">[\s\S]*?<text )x="[\d.]+" y="[\d.]+"/, `$1x="${mid.x}" y="${mid.y + 4}"`);
    expect(codes(moved, circuit)).toContain("SCH-LABEL-ON-WIRE");
  });

  it("a trace cutting through another part's symbol", () => {
    const { circuit, svg } = drawing("launch-control");
    const led = parseSchematicSvg(svg).items.find((item) => item.part === "LED3")!;
    const body = led.shapes.find((shape) => shape.type === "area")!;
    if (body.type !== "area") throw new Error("LED3 has no body");
    const y = (body.box.top + body.box.bottom) / 2 - 3;
    const through = appendToNet(svg, "D8", `<polyline class="wire" points="${body.box.left - 30},${y} ${body.box.right + 30},${y}"/>`);
    expect(codes(through, circuit)).toContain("SCH-WIRE-THROUGH-SYMBOL");
  });

  it("buttons left as unwired islands", () => {
    const { circuit, svg } = drawing("dishwasher-panel");
    expect(codes(removeGroup(svg, '<g class="net" data-net="D2">'), circuit)).toContain("SCH-NET-UNWIRED");
  });

  it("symbols drawn on top of each other", () => {
    const { circuit, svg } = drawing("dishwasher-panel");
    const parsed = parseSchematicSvg(svg);
    const [first, second] = ["BTN1", "BTN2"].map((id) => parsed.items.find((item) => item.part === id)!.leads[0]!.seg.a);
    const moved = shiftGroup(svg, '<g class="part" data-part="BTN2">', first!.x - second!.x + 6, first!.y - second!.y + 4);
    expect(codes(moved, circuit)).toContain("SCH-SYMBOL-OVERLAP");
  });

  it("a branch without its junction dot, and two nets touching", () => {
    const { circuit, svg } = drawing("dishwasher-shared-resistor");
    const noDot = svg.replace(/<circle class="junction"[^>]*\/>/, "");
    expect(codes(noDot, circuit)).toContain("SCH-JUNCTION-MISSING");
    const mid = wireMidpoint(svg, "D5");
    const touching = appendToNet(svg, "D4", `<polyline class="wire" points="${mid.x},${mid.y - 25} ${mid.x},${mid.y}"/>`);
    expect(codes(touching, circuit)).toContain("SCH-WIRE-TOUCH");
  });

  it("a missing ground symbol and a drawing clipped by its viewBox", () => {
    const { circuit, svg } = drawing("dishwasher-shared-resistor");
    expect(codes(removeGroup(svg, '<g class="power" data-net="GND" data-pin="R1.2">'), circuit)).toContain("SCH-POWER-MISSING");
    const clipped = svg.replace(/viewBox="0 0 (\d+) (\d+)"/, (_, width: string, height: string) => `viewBox="0 0 ${Number(width) - 120} ${height}"`);
    expect(codes(clipped, circuit)).toContain("SCH-OUTSIDE");
  });
});

describe("connection-table fallback", () => {
  it("replaces a drawing that fails the check", () => {
    const { circuit, svg } = drawing("dishwasher-shared-resistor");
    const broken = shiftGroup(svg, '<g class="part" data-part="R1">', 0, 40);
    const result = verifiedSchematic(circuit, broken);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.svg).toContain('data-schematic="connection-table"');
    expect(result.svg).toContain("Connection table: Pretend Dishwasher Panel (shared resistor)");
    expect(checkTextLayout(result.svg)).toEqual([]);
    expect(verifiedSchematic(circuit, svg).svg).toBe(svg);
  });

  it("lists every connected part pin with its Arduino pin or net", () => {
    const { circuit } = drawing("dishwasher-shared-resistor");
    const rows = connectionRows(circuit);
    expect(rows.find((row) => row.pin.startsWith("LED1 (Quick mode light) · A"))?.connectsTo).toBe("Arduino D4");
    expect(rows.find((row) => row.pin.startsWith("LED1 (Quick mode light) · K"))).toMatchObject({ connectsTo: "LED2 · K, LED3 · K, LED4 · K, R1 · 1", net: "LK" });
    expect(rows.find((row) => row.pin.startsWith("R1 (Shared LED resistor) · 2"))).toMatchObject({ connectsTo: "GND (Arduino GND)", net: "GND" });
    expect(rows).toHaveLength(circuit.nets.reduce((sum, net) => sum + net.pins.filter((ref) => ref.part !== "board").length, 0));
    expect(checkTextLayout(connectionTableSvg(circuit))).toEqual([]);
  });
});
