/**
 * How buildable a layout is (design philosophy rules 1–6, HOW-IT-WORKS.md "Design philosophy"): wire count, wire
 * crossings, total wire length, whether every set of repeated units is built as identical copies at a fixed pitch,
 * and whether the copies run left to right in the order the design gives. The allocator picks the layout with the lowest score among those that meet every hard constraint (LVS clean,
 * every explicit placement request met); the assembly console reports crossings and irregular repeats.
 */
import { parseHole, type Circuit, type Layout } from "@vibread/core";

import { endpointPosition, jumperRoute, segmentsCross } from "./svg.js";
import { repeatedUnits, statedIndex, type UnitSet } from "./units.js";

/** Hole pitch in drawing units (bb-830: 1010 / 62). */
const PITCH_PX = 16.3;

export interface RepeatQuality {
  /** Parts of each copy, left to right as built. */
  copies: string[][];
  regular: boolean;
  /** Copies left to right in the order the design asks for (rule 1). */
  inOrder: boolean;
  /** Columns between copies when regular. */
  pitch?: number;
  /** Leftmost column of each copy. */
  columns: number[];
  orderedBy: UnitSet["orderedBy"];
}

export interface LayoutQuality {
  wires: number;
  crossings: number;
  /** Pairs of crossing wires, for the report. */
  crossingPairs: [string, string][];
  /** Total wire length in hole pitches (straight line, end to end). */
  wireLength: number;
  repeats: RepeatQuality[];
  irregular: number;
  /** Sets of copies not left to right in their order. */
  outOfOrder: number;
  /** Lower is better. */
  score: number;
}

type Point = { x: number; y: number };

export type Segment = [Point, Point];

/** A jumper as drawn for crossing checks: its straight end-to-end line, or its edge-hugging route. */
export function jumperSegments(layout: Layout, jumper: Pick<Layout["jumpers"][number], "from" | "to">): Segment[] {
  const points = jumperRoute(layout, jumper) ?? [endpointPosition(layout, jumper.from), endpointPosition(layout, jumper.to)];
  return points.slice(1).map((point, index): Segment => [points[index]!, point]);
}

export function wiresCross(a: Segment[], b: Segment[]): boolean {
  return a.some((first) => b.some((second) => segmentsCross(first, second)));
}

/**
 * Pairs of jumpers that cross in the drawing: each wire's straight end-to-end line, or the route an edge-hugging wire
 * (an Uno rail feed, a split-rail bridge) is drawn along.
 */
export function jumperCrossings(layout: Layout): [string, string][] {
  const wires = layout.jumpers.map((jumper) => ({ id: jumper.id, segments: jumperSegments(layout, jumper) }));
  const pairs: [string, string][] = [];
  for (let i = 0; i < wires.length; i += 1) {
    for (let j = i + 1; j < wires.length; j += 1) {
      if (wiresCross(wires[i]!.segments, wires[j]!.segments)) pairs.push([wires[i]!.id, wires[j]!.id]);
    }
  }
  return pairs;
}

/** Column of a hole (a rail hole's position lines up with the numbered columns). */
function holeColumn(hole: string): number | undefined {
  const parsed = parseHole(hole);
  return parsed === null ? undefined : parsed.kind === "terminal" ? parsed.row : parsed.position;
}

/** A copy's shape: every pin's lettered row (or rail) and column offset from the copy's leftmost column. */
function copyShape(layout: Layout, parts: string[]): { base: number; shape: string } | undefined {
  const holes = parts.flatMap((part) => {
    const pins = layout.placements.find((placement) => placement.part === part)?.pins ?? {};
    return Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)).map(([pin, hole]) => ({ part, pin, hole }));
  });
  const columns = holes.map((entry) => holeColumn(entry.hole)).filter((column): column is number => column !== undefined);
  if (columns.length === 0) return undefined;
  const base = Math.min(...columns);
  const shape = holes.map((entry, index) => {
    const parsed = parseHole(entry.hole);
    const lane = parsed?.kind === "terminal" ? parsed.column : parsed?.kind === "rail" ? parsed.rail : "?";
    // Parts are named by their position in the copy, so LED1's copy and LED2's copy compare equal.
    return `${parts.indexOf(entry.part)}.${entry.pin}@${lane}${(holeColumn(entry.hole) ?? 0) - base}#${index}`;
  });
  return { base, shape: shape.join(" ") };
}

export function repeatQuality(layout: Layout, set: UnitSet): RepeatQuality {
  const copies = set.copies.map((copy) => copy.parts);
  const shapes = copies.map((parts) => copyShape(layout, parts));
  const columns = shapes.map((shape) => shape?.base ?? 0);
  const same = shapes.every((shape) => shape !== undefined && shape.shape === shapes[0]!.shape);
  const steps = columns.slice(1).map((column, index) => column - columns[index]!);
  const pitch = steps[0];
  const regular = same && pitch !== undefined && pitch > 0 && steps.every((step) => step === pitch);
  const inOrder = steps.every((step) => step > 0);
  return { copies, regular, inOrder, ...(regular ? { pitch } : {}), columns, orderedBy: set.orderedBy };
}

export function layoutQuality(circuit: Circuit, layout: Layout): LayoutQuality {
  const crossingPairs = jumperCrossings(layout);
  const wireLength = layout.jumpers.reduce((sum, jumper) => {
    const a = endpointPosition(layout, jumper.from);
    const b = endpointPosition(layout, jumper.to);
    return sum + Math.hypot(a.x - b.x, a.y - b.y) / PITCH_PX;
  }, 0);
  const repeats = repeatedUnits(circuit).map((set) => repeatQuality(layout, set));
  const irregular = repeats.filter((entry) => !entry.regular).length;
  const outOfOrder = repeats.filter((entry) => !entry.inOrder).length + labelOrderProblems(circuit, layout).length;
  const wires = layout.jumpers.length;
  // Rules 1–2 outweigh rule 4: copies in the idea's order and built alike beat a few saved wires or crossings.
  const score = wires * 10 + crossingPairs.length * 30 + irregular * 150 + outOfOrder * 400 + wireLength * 0.3;
  return { wires, crossings: crossingPairs.length, crossingPairs, wireLength: Math.round(wireLength * 10) / 10, repeats, irregular, outOfOrder, score: Math.round(score * 10) / 10 };
}

/**
 * Parts whose label (or pin role) states a position among their kind ("Moon light 1 (leftmost)", "2 from right") but
 * sit elsewhere in the layout, left to right. Empty when every stated position holds.
 */
export function labelOrderProblems(circuit: Circuit, layout: Layout): string[] {
  const problems: string[] = [];
  const modules = [...new Set(circuit.parts.map((part) => part.module))];
  for (const module of modules) {
    const parts = circuit.parts.filter((part) => part.module === module);
    if (parts.length < 2) continue;
    const leftmost = (id: string) => Math.min(...Object.values(layout.placements.find((placement) => placement.part === id)?.pins ?? {}).map((hole) => holeColumn(hole) ?? 999));
    const actual = parts.map((part) => part.id).sort((a, b) => leftmost(a) - leftmost(b));
    for (const part of parts) {
      const stated = statedIndex(circuit, part.id, parts.length);
      if (stated === undefined) continue;
      const at = actual.indexOf(part.id);
      if (at !== stated) problems.push(`${part.id} ("${part.label ?? part.id}") is ${ordinal(at + 1)} from the left, not ${ordinal(stated + 1)}`);
    }
  }
  return problems;
}

function ordinal(n: number): string {
  return `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
}
