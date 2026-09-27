import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { BREADBOARD_PROFILES, CircuitSchema, parseHole, type Circuit, type Layout } from "@vibread/core";

import { buildSteps, jumperCrossings, layoutBoard, lvs } from "./index.js";
import { jumperRoute, partDrawingBox, renderBreadboardSvg } from "./svg.js";

/**
 * Issue #28: the Uno's 5 V / GND wires enter their rail at its end nearest the Uno's power header and are drawn around
 * the outside of the breadboard; split-rail bridges hug the board edge; the pot is drawn over its whole footprint.
 */
const FIXTURES = new URL("../../../../fixtures/schematic/", import.meta.url);
const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
const designs: [string, Circuit][] = [
  ...GOLDEN.map((design) => [design.key, design.circuit] as [string, Circuit]),
  ...readdirSync(FIXTURES).filter((name) => name.endsWith(".json")).sort().map((name) => [name.replace(/\.json$/, ""), CircuitSchema.parse(JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")))] as [string, Circuit]),
  ["moon-phase-lamp on bb-400", { ...moon, breadboard: { profile: "bb-400" } }],
  ["moon-phase-lamp on bb-830-split", { ...moon, breadboard: { profile: "bb-830-split" } }],
];

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };

/** Drawn hole centres, read from the picture itself. */
function holeCentres(svg: string): Map<string, Point> {
  return new Map([...svg.matchAll(/id="hole-([^"]+)" cx="([\d.]+)" cy="([\d.]+)"/g)].map((match) => [match[1]!, { x: Number(match[2]), y: Number(match[3]) }]));
}

/** Points every 2 drawing units along a polyline. */
function samples(points: Point[]): Point[] {
  return points.slice(1).flatMap((to, index) => {
    const from = points[index]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    return Array.from({ length: steps + 1 }, (_, step) => ({ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }));
  });
}

const inside = (point: Point, box: Box) => point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;

function feeds(layout: Layout) {
  return layout.jumpers.filter((jumper) => "board" in jumper.from && "hole" in jumper.to && parseHole(jumper.to.hole)?.kind === "rail");
}

describe("rail feeds at the rail's end, around the board edge (issue #28)", () => {
  it.each(designs)("%s: each Uno rail wire ends in the rail's end hole on the Uno's power-header side", (_key, circuit) => {
    const layout = layoutBoard(circuit);
    const positions = BREADBOARD_PROFILES[layout.breadboard].railPositions;
    const end = layout.boardOrientation === "usb-left" ? positions[0] : positions.at(-1);
    expect(feeds(layout).length).toBeGreaterThan(0);
    for (const jumper of feeds(layout)) {
      const hole = parseHole("hole" in jumper.to ? jumper.to.hole : "")!;
      expect(hole.kind === "rail" && hole.position, jumper.id).toBe(end);
    }
    expect(lvs(circuit, layout).ok).toBe(true);
  });

  it.each(designs)("%s: rail wires are drawn outside the strips and every part, crossing no other wire", (_key, circuit) => {
    const layout = layoutBoard(circuit);
    const svg = renderBreadboardSvg({ circuit, layout });
    const holes = holeCentres(svg);
    const strips = [...holes].filter(([hole]) => parseHole(hole)?.kind === "terminal").map(([, point]) => point);
    // The terminal strips' area, out to the holes' rims.
    const area: Box = { left: Math.min(...strips.map((point) => point.x)) - 6, right: Math.max(...strips.map((point) => point.x)) + 6, top: Math.min(...strips.map((point) => point.y)) - 6, bottom: Math.max(...strips.map((point) => point.y)) + 6 };
    const parts = layout.placements.map((placement) => partDrawingBox(layout.breadboard, circuit.parts.find((part) => part.id === placement.part)!, placement.pins));
    const crossings = jumperCrossings(layout);
    for (const jumper of feeds(layout)) {
      const route = jumperRoute(layout, jumper);
      expect(route, jumper.id).toBeDefined();
      // The last point is the rail hole the wire goes into, drawn where the picture draws that hole.
      const hole = holes.get("hole" in jumper.to ? jumper.to.hole : "")!;
      expect(route!.at(-1)!.x).toBeCloseTo(hole.x, 0);
      expect(route!.at(-1)!.y).toBe(hole.y);
      for (const point of samples(route!)) {
        expect(inside(point, area), `${jumper.id} at ${point.x},${point.y}`).toBe(false);
        for (const box of parts) expect(inside(point, box), `${jumper.id} over a part at ${point.x},${point.y}`).toBe(false);
      }
      expect(crossings.filter((pair) => pair.includes(jumper.id))).toEqual([]);
    }
  });

  it("names the rail's end column and the way round in the rails step", () => {
    for (const [key, circuit] of designs) {
      const layout = layoutBoard(circuit);
      const rails = buildSteps(circuit, layout).steps.find((step) => step.kind === "rails")!;
      const positions = BREADBOARD_PROFILES[layout.breadboard].railPositions;
      const [where, side] = layout.boardOrientation === "usb-left" ? ["first", "left"] : ["last", "right"];
      const column = layout.boardOrientation === "usb-left" ? positions[0] : positions.at(-1);
      for (const jumper of feeds(layout)) {
        expect(rails.text, key).toContain(`→ hole ${"hole" in jumper.to ? jumper.to.hole : ""} on the`);
        expect(rails.text, key).toContain(`the rail's ${where} hole (column ${column}); run it around the ${side} end of the breadboard, not across it.`);
      }
    }
  });

  it("draws split-rail bridges as staples on the board-edge side of their rail", () => {
    const split = designs.find(([key]) => key.endsWith("bb-830-split"))![1];
    const layout = layoutBoard(split);
    const holes = holeCentres(renderBreadboardSvg({ circuit: split, layout }));
    const bridges = layout.jumpers.filter((jumper) => "hole" in jumper.from && "hole" in jumper.to && /^T[+-]30$/.test(jumper.from.hole));
    expect(bridges.map((jumper) => ("hole" in jumper.from ? jumper.from.hole : "")).sort()).toEqual(["T+30", "T-30"]);
    const railY = (rail: string) => holes.get(`${rail}2`)!.y;
    for (const bridge of bridges) {
      const rail = "hole" in bridge.from ? bridge.from.hole.slice(0, 2) : "";
      const standoff = jumperRoute(layout, bridge)!.slice(1, -1).map((point) => point.y);
      // The − rail's staple runs between the rail and the board edge, the + rail's between the two rails.
      for (const y of standoff) {
        if (rail === "T-") expect(y).toBeLessThan(railY("T-"));
        else expect(y > railY("T-") && y < railY("T+"), `${bridge.id} at y ${y}`).toBe(true);
      }
    }
    expect(jumperCrossings(layout)).toEqual([]);
  });

  it("goes round the far end when a part's leg sits in the near end hole, and draws a mid-rail feed as a plain wire", () => {
    const layout = layoutBoard(moon);
    const gnd = feeds(layout).find((jumper) => "hole" in jumper.to && jumper.to.hole.startsWith("T-"))!;
    expect(gnd.to).toEqual({ hole: "T-60" });
    // An LED's K leg moved into T-60: the allocator's fallback is the rail's other end, T-2.
    const led = layout.placements.find((placement) => /^T-/.test(placement.pins.K ?? ""))!;
    const blocked: Layout = {
      ...layout,
      placements: layout.placements.map((placement) => (placement === led ? { ...placement, pins: { ...placement.pins, K: "T-60" } } : placement)),
      jumpers: layout.jumpers.map((jumper) => (jumper === gnd ? { ...jumper, to: { hole: "T-2" } } : jumper)),
    };
    const route = jumperRoute(blocked, { ...gnd, to: { hole: "T-2" } })!;
    expect(route).toBeDefined();
    // Up the left side of the board, beside column 1, into T-2 from the edge.
    expect(Math.min(...route.map((point) => point.x))).toBeLessThan(route.at(-1)!.x - 40);
    expect(jumperCrossings(blocked).filter((pair) => pair.includes(gnd.id))).toEqual([]);
    // Both ends taken: the feed goes mid-rail and is drawn as an ordinary wire, never over a used hole.
    const both: Layout = { ...blocked, jumpers: blocked.jumpers.map((jumper) => (jumper.id === gnd.id ? { ...jumper, to: { hole: "T-36" } } : jumper)), placements: [...blocked.placements, { part: "X", pins: { "1": "T-2" } }] };
    expect(jumperRoute(both, { ...gnd, to: { hole: "T-36" } })).toBeUndefined();
  });

  it("leaves boards without rails and ordinary wires as they were", () => {
    const mini = { ...moon, breadboard: { profile: "bb-170" as const } };
    const layout = layoutBoard(mini);
    for (const jumper of layout.jumpers) expect(jumperRoute(layout, jumper), jumper.id).toBeUndefined();
    const full = layoutBoard(moon);
    for (const jumper of full.jumpers.filter((entry) => !feeds(full).includes(entry))) expect(jumperRoute(full, jumper), jumper.id).toBeUndefined();
  });
});

describe("the potentiometer is drawn over its whole footprint (issue #28)", () => {
  const knob = GOLDEN.find((design) => design.key === "knob-night-light")!.circuit;
  const layout = layoutBoard(knob);
  const pot = knob.parts.find((part) => part.module === "potentiometer")!;
  const placement = layout.placements.find((entry) => entry.part === pot.id)!;
  const svg = renderBreadboardSvg({ circuit: knob, layout });
  const holes = holeCentres(svg);
  const rows = BREADBOARD_PROFILES[layout.breadboard].rows;
  const pitch = (holes.get(`e${rows}`)!.x - holes.get("e1")!.x) / (rows - 1);

  const group = svg.match(new RegExp(`<g id="part-${pot.id}"[\\s\\S]*?</g>`))![0];
  const [, bx, by, bw, bh] = group.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="6" class="pot-base"\/>/)!.map(Number);
  const body: Box = { left: bx!, top: by!, right: bx! + bw!, bottom: by! + bh! };

  it("spans 6 columns around its legs, inside its drawing box, clear of other parts and other nets' wire ends", () => {
    const legs = Object.values(placement.pins).map((hole) => holes.get(hole)!);
    const middle = (Math.min(...legs.map((leg) => leg.x)) + Math.max(...legs.map((leg) => leg.x))) / 2;
    expect(body.right - body.left).toBeGreaterThanOrEqual(6 * pitch - 4);
    expect(body.left).toBeLessThan(middle - 2.85 * pitch);
    expect(body.right).toBeGreaterThan(middle + 2.85 * pitch);
    // The drawing box the allocator keeps other parts off covers the body and the legs.
    const box = partDrawingBox(layout.breadboard, pot, placement.pins);
    for (const corner of [{ x: body.left, y: body.top }, { x: body.right, y: body.bottom }, ...legs]) expect(inside(corner, { left: box.left - 1, top: box.top - 1, right: box.right + 1, bottom: box.bottom + 1 })).toBe(true);
    for (const other of layout.placements.filter((entry) => entry.part !== pot.id)) {
      const part = knob.parts.find((entry) => entry.id === other.part)!;
      const theirs = partDrawingBox(layout.breadboard, part, other.pins);
      const overlap = theirs.left < body.right && body.left < theirs.right && theirs.top < body.bottom && body.top < theirs.bottom;
      expect(overlap, `${part.id} over ${pot.id}'s body`).toBe(false);
    }
    const potStrips = new Set(Object.values(placement.pins).map((hole) => parseHole(hole)!).map((hole) => (hole.kind === "terminal" ? hole.row : -1)));
    for (const jumper of layout.jumpers) {
      for (const end of [jumper.from, jumper.to]) {
        const hole = "hole" in end ? parseHole(end.hole) : null;
        if (hole?.kind !== "terminal" || potStrips.has(hole.row)) continue;
        expect(inside(holes.get("hole" in end ? end.hole : "")!, body), `${jumper.id} ends under ${pot.id}`).toBe(false);
      }
    }
  });

  it("draws legs A, W and B with a foot on each of their holes, and a body under the knob", () => {
    expect(group).toContain('class="pot-base"');
    expect(group).toContain('class="pot-body"');
    const feet = [...group.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="3.5" class="leg-foot"\/>/g)].map((match) => `${Number(match[1]).toFixed(1)},${match[2]}`);
    expect(feet.sort()).toEqual(Object.values(placement.pins).map((hole) => `${holes.get(hole)!.x.toFixed(1)},${holes.get(hole)!.y}`).sort());
    expect(group.match(/class="leg"/g)).toHaveLength(3);
    for (const pin of ["A", "W", "B"]) expect(group).toContain(`class="pot-pin">${pin}</text>`);
  });
});
