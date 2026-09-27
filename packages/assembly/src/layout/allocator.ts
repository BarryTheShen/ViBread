/**
 * Breadboard allocator: places every part and realizes every IR net with the breadboard's five-hole strips, the power
 * rails, and jumpers, then proves the result with LVS before returning it.
 *
 * Model: a strip (row r, a–e or f–j) belongs to at most one net. Parts are placed one at a time (connected parts
 * back to back, starting from the Arduino pins in pin order); each candidate position is scored so pins reuse a strip
 * their net already owns, which saves a jumper. After placement every net is one or more "islands" (strips, a rail,
 * Arduino header pins, joined by the parts' internal connections); a capacity-aware spanning tree over the islands
 * adds the jumpers, with a spare strip as a hub when the islands run out of free holes. Each strip keeps at least one
 * free hole for exactly that purpose.
 *
 * Every breadboard profile works: a board without rails (mini) carries 5 V and GND in strips like any other net; a
 * board with split rails gets a bridge wire across the gap of every rail the build uses (with the rails, before any
 * part). Part variants (`params.variant`) pick their own footprint: a 12 mm button's legs in columns d/g, a panel
 * pot's legs two holes apart, a 2-leg button's legs "1" and "3" only.
 *
 * Several placement strategies are tried in order; the first whose layout is LVS-clean wins. When none fits, the
 * allocator throws `LayoutFitError` (tool-side: the circuit is fine, the breadboard or ViBread's placer is not).
 */
import {
  BOARD_PART,
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  MODULES,
  contactGroup,
  hashJson,
  isRailBridge,
  isValidHole,
  modulePins,
  parseHole,
  partVariant,
  pinKey,
  powerRails,
  railBridge,
  type BreadboardProfile,
  type Circuit,
  type Column,
  type Endpoint,
  type HoleId,
  type Jumper,
  type Layout,
  type Part,
  type Placement,
  type BoardOrientation,
  type RailId,
  type WireColor,
} from "@vibread/core";
import { defaultNetColors } from "./colors.js";
import { lvs } from "./lvs.js";
import { GROUP_GAP, partExtent, placementSummary } from "./placement.js";
import { layoutQuality, type LayoutQuality } from "./quality.js";
import { headerRow, partDrawingBox, type DrawingBox } from "./svg.js";
import { repeatedUnits, type Unit, type UnitCopy, type UnitMember, type UnitSet } from "./units.js";

type Side = "left" | "right";

/** Part columns fill from the centre channel outward; jumper ends fill from the rail edge inward. */
const PART_COLUMNS: Record<Side, readonly Column[]> = { left: ["e", "d", "c", "b", "a"], right: ["f", "g", "h", "i", "j"] };
const JUMPER_COLUMNS: Record<Side, readonly Column[]> = { left: ["a", "b", "c", "d", "e"], right: ["j", "i", "h", "g", "f"] };

/** Thrown when no strategy produces an LVS-clean layout. `toolSide` means the circuit itself is valid. */
export class LayoutFitError extends Error {
  readonly toolSide: boolean;
  constructor(message: string, toolSide: boolean) {
    super(message);
    this.name = "LayoutFitError";
    this.toolSide = toolSide;
  }
}

interface Strategy {
  /** Uno below the breadboard: which end its USB socket faces (the header reads the other way round). */
  orientation: BoardOrientation;
  /**
   * Build repeated units as identical copies first (design philosophy rule 2), using the `anchorRank`-th best start
   * column for the largest set; off for the plain packings. Both kinds are candidates of the same search, scored alike.
   */
  repeats?: { anchorRank: number };
  /** Free holes every strip keeps after part placement (jumper room). */
  reserve: number;
  /** Keep every part's drawing (body, leads, label) clear of the others; off for the tightest packing. */
  spread: boolean;
  /** Part order: connected parts together (true) or by reference designator. */
  grouped: boolean;
  /** Honour the circuit's placement groups (side by side, left to right as listed). */
  placementGroups: boolean;
}

const PACKINGS: Omit<Strategy, "placementGroups" | "orientation">[] = [
  { reserve: 1, spread: true, grouped: true },
  { reserve: 2, spread: true, grouped: true },
  { reserve: 1, spread: false, grouped: true },
  { reserve: 1, spread: false, grouped: false },
  { reserve: 2, spread: false, grouped: false },
];

interface Ctx {
  circuit: Circuit;
  profile: BreadboardProfile;
  strategy: Strategy;
  /** "LED1.A" → net id; unconnected pins get a private "__nc:" net. */
  pinNet: Map<string, string>;
  /** Suggested wire colour per net (colors.ts). */
  colors: Record<string, WireColor>;
  /** Contact group → owning net ("__board" for unused Nano header rows). */
  stripNet: Map<string, string>;
  /** Hole → what occupies it: a pin key, "body:<part>", "jumper", or "board:<pin>". */
  occupied: Map<HoleId, string>;
  /** Contact group → free holes left (5 when absent). */
  freeCount: Map<string, number>;
  /** Net → rows of the strips it owns. */
  netRows: Map<string, number[]>;
  placements: Placement[];
  /** Drawn extents of placed parts. */
  bodies: DrawingBox[];
  /** Placement groups being honoured: part → group index, and each group's rows/half so far. */
  groupOfPart: Map<string, number>;
  groupSpans: ([number, number] | undefined)[];
  /** Rows of each group's first listed part (its anchor: the others sit within GROUP_GAP rows of it). */
  groupAnchor: ([number, number] | undefined)[];
  groupHalf: ("a-e" | "f-j" | undefined)[];
  jumpers: { jumper: Jumper; phase: number }[];
  /** Net → rail it uses (the Arduino 5 V net → the + rail, the Arduino GND net → the − rail); empty without rails. */
  railOf: Map<string, RailId>;
  /** Nano only: header hole per used board pin. */
  headerHoles: Map<string, HoleId[]>;
  /** Net → breadboard row above its Uno header pin (short, straight board wires). */
  homeRow: Map<string, number>;
  /** Nets with a part leg straight in a rail hole (a repeated unit's resistor into the GND rail). */
  railPinNets: Set<string>;
  /** Columns the repeated units occupy; other parts stay clear of them (with one column to spare). */
  keepOut: [number, number][];
  boardAnchor?: Layout["boardAnchor"];
}

// ---------------------------------------------------------------------------------------------------------------
// Basics

function holeRow(hole: HoleId): number {
  const parsed = parseHole(hole);
  return parsed === null ? 0 : parsed.kind === "terminal" ? parsed.row : parsed.position;
}

function stripId(side: Side, row: number): string {
  return `r${row}:${side === "left" ? "a-e" : "f-j"}`;
}

function stripHoles(side: Side, row: number): HoleId[] {
  return JUMPER_COLUMNS[side].map((column) => `${column}${row}`);
}

function groupOf(ctx: Ctx, hole: HoleId): string {
  const group = contactGroup(ctx.profile, hole);
  if (group === null) throw new Error(`invalid hole ${hole} on ${ctx.profile.id}`);
  return group;
}

function freeHoles(ctx: Ctx, side: Side, row: number): HoleId[] {
  return stripHoles(side, row).filter((hole) => !ctx.occupied.has(hole));
}

/** Every hole assignment goes through here so the per-strip free counts stay exact. */
function occupy(ctx: Ctx, hole: HoleId, owner: string): void {
  if (ctx.occupied.has(hole)) throw new Error(`internal allocator error: hole ${hole} used twice`);
  ctx.occupied.set(hole, owner);
  if (parseHole(hole)?.kind === "terminal") {
    const group = groupOf(ctx, hole);
    ctx.freeCount.set(group, (ctx.freeCount.get(group) ?? 5) - 1);
  }
}

function claimStrip(ctx: Ctx, group: string, net: string): void {
  if (ctx.stripNet.get(group) === net) return;
  ctx.stripNet.set(group, net);
  const row = Number(group.slice(1, group.indexOf(":")));
  ctx.netRows.set(net, [...(ctx.netRows.get(net) ?? []), row]);
}

function boardPinRank(pin: string): number {
  const match = /^([DA])(\d+)$/.exec(pin);
  if (match) return match[1] === "D" ? Number(match[2]) : 100 + Number(match[2]);
  return 300;
}

function endpointKey(endpoint: Endpoint): string {
  return "hole" in endpoint ? `hole:${endpoint.hole}` : `board:${endpoint.board}`;
}

function buildPinNets(circuit: Circuit): Map<string, string> {
  const pinNet = new Map<string, string>();
  for (const net of circuit.nets) for (const ref of net.pins) pinNet.set(pinKey(ref), net.id);
  for (const part of circuit.parts) {
    for (const group of MODULES[part.module].internallyConnected ?? []) {
      const known = [...new Set(group.map((pin) => pinNet.get(`${part.id}.${pin}`)).filter((net): net is string => net !== undefined))];
      if (known.length > 1) throw new LayoutFitError(`${part.id} pins ${group.join(" and ")} are joined inside the part but the design puts them on different nets (${known.join(", ")}).`, false);
      const net = known[0] ?? `__nc:${part.id}.${group.join("")}`;
      for (const pin of group) pinNet.set(`${part.id}.${pin}`, net);
    }
    for (const pin of modulePins(part)) {
      const key = `${part.id}.${pin.id}`;
      if (!pinNet.has(key)) pinNet.set(key, `__nc:${key}`);
    }
  }
  return pinNet;
}

function wireColor(ctx: Ctx, net: string): WireColor {
  return ctx.colors[net] ?? "white";
}

function addJumper(ctx: Ctx, from: Endpoint, to: Endpoint, net: string, phase: number): void {
  if (endpointKey(from) === endpointKey(to)) return;
  for (const endpoint of [from, to]) if ("hole" in endpoint) occupy(ctx, endpoint.hole, "jumper");
  ctx.jumpers.push({ phase, jumper: { id: "", from, to, color: wireColor(ctx, net), net } });
}

// ---------------------------------------------------------------------------------------------------------------
// Part placement

interface Candidate {
  pins: Record<string, HoleId>;
  /** Holes the part body lies over (between leads, under a button). */
  covered: HoleId[];
  body: DrawingBox;
  cost: number;
}

/** Pin row offsets for each orientation of a part's footprint (its variant's legs when it has one). */
function footprintShapes(part: Part): { pins: string[]; offsets: number[]; spanPenalty: number }[] {
  const footprint = MODULES[part.module].footprint;
  const variant = partVariant(part)?.footprint;
  const shapes: { pins: string[]; offsets: number[]; spanPenalty: number }[] = [];
  if (variant?.kind === "button2") {
    shapes.push({ pins: ["1", "3"], offsets: [0, variant.span], spanPenalty: 0 });
    shapes.push({ pins: ["3", "1"], offsets: [0, variant.span], spanPenalty: 0.01 });
    return shapes;
  }
  if (footprint.kind === "two-lead") {
    // A variant fixes the span (its legs); otherwise the module's range, preferring its usual span.
    const [minSpan, maxSpan] = variant?.kind === "two-lead" ? [variant.span, variant.span] : [footprint.minSpan, footprint.maxSpan];
    for (let span = minSpan; span <= maxSpan; span += 1) {
      const spanPenalty = variant?.kind === "two-lead" ? 0 : Math.abs(span - footprint.preferredSpan) * 0.3;
      shapes.push({ pins: [footprint.pins[0], footprint.pins[1]], offsets: [0, span], spanPenalty });
      shapes.push({ pins: [footprint.pins[1], footprint.pins[0]], offsets: [0, span], spanPenalty: spanPenalty + 0.01 });
    }
    return shapes;
  }
  const pins = footprint.kind === "inline3" ? [...footprint.pins] : modulePins(part).map((pin) => pin.id);
  const pitch = variant?.kind === "inline3" ? variant.pitch : 1;
  shapes.push({ pins, offsets: pins.map((_, index) => index * pitch), spanPenalty: 0 });
  if (pins.length > 1) shapes.push({ pins: [...pins].reverse(), offsets: pins.map((_, index) => index * pitch), spanPenalty: 0.01 });
  return shapes;
}

/** Nearest row distance from `row` to any strip `net` owns (Infinity when it owns none). */
function nearestOwnStrip(ctx: Ctx, net: string, row: number): number {
  let best = Infinity;
  for (const stripRow of ctx.netRows.get(net) ?? []) best = Math.min(best, Math.abs(stripRow - row));
  return best;
}

/** One pin (or covered hole) of a candidate, already resolved to its strip. */
interface Slot {
  hole: HoleId;
  group: string;
  row: number;
  /** undefined for a covered hole. */
  net?: string;
}

/**
 * Cost of one candidate, or undefined when a hole is taken, a strip belongs to another net, or a strip would be left
 * without `reserve` free holes. Cheap: the drawing-overlap check runs only for candidates that beat the best so far.
 */
function slotCost(ctx: Ctx, slots: Slot[], spanPenalty: number): number | undefined {
  let cost = spanPenalty;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    if (ctx.occupied.has(slot.hole)) return undefined;
    let used = 0;
    let claimed: string | undefined;
    for (const other of slots) {
      if (other.group !== slot.group) continue;
      used += 1;
      if (other.net !== undefined) {
        if (claimed !== undefined && claimed !== other.net) return undefined;
        claimed = other.net;
      }
    }
    if ((ctx.freeCount.get(slot.group) ?? 5) - used < ctx.strategy.reserve) return undefined;
    if (slot.net === undefined) continue;
    const owner = ctx.stripNet.get(slot.group);
    if (owner !== undefined && owner !== slot.net) return undefined;
    // Score each fresh strip once (at its first slot).
    if (owner === slot.net || slots.findIndex((other) => other.group === slot.group && other.net !== undefined) !== index) continue;
    // A fresh strip. Rail nets reach it with one short wire from the top rail (cheaper on the top a–e side); a
    // signal net that already lives elsewhere needs a strip-to-strip jumper, the longer the costlier.
    cost += 4;
    if (ctx.railOf.has(slot.net)) cost += 2 + (slot.group.endsWith("f-j") ? 2 : 0);
    else {
      const distance = nearestOwnStrip(ctx, slot.net, slot.row);
      if (Number.isFinite(distance)) cost += 6 + distance * 0.1;
    }
    const home = ctx.homeRow.get(slot.net);
    if (home !== undefined) cost += Math.abs(slot.row - home) * 0.06;
  }
  return cost;
}

function slot(ctx: Ctx, part: Part, column: Column, row: number, pin?: string): Slot {
  const hole = `${column}${row}`;
  return { hole, row, group: stripId(column <= "e" ? "left" : "right", row), ...(pin === undefined ? {} : { net: ctx.pinNet.get(`${part.id}.${pin}`)! }) };
}

/**
 * Placement-group rule for a candidate (issue #16): a grouped part stays within GROUP_GAP rows of its group's anchor
 * (first listed part), on the group's half, to the right of every earlier group; an ungrouped part stays out of the
 * groups' rows.
 */
function groupAllows(ctx: Ctx, part: Part, pins: Record<string, HoleId>): boolean {
  const extent = partExtent(pins);
  if (!extent) return true;
  const [from, to] = extent.rows;
  const group = ctx.groupOfPart.get(part.id);
  if (group === undefined) return ctx.groupSpans.every((span) => !span || to < span[0] || from > span[1]);
  const earlier = ctx.groupSpans.slice(0, group).filter((span): span is [number, number] => span !== undefined);
  if (earlier.length > 0 && from <= Math.max(...earlier.map((span) => span[1])) + 1) return false;
  // A row of like parts: each one right of the one listed before it, within GROUP_GAP rows (placement.ts).
  const members = ctx.circuit.placement?.groups[group] ?? [];
  if (members.length >= 2 && new Set(members.map((id) => ctx.circuit.parts.find((entry) => entry.id === id)?.module)).size === 1) {
    const previousId = members[members.indexOf(part.id) - 1];
    const previous = previousId === undefined ? undefined : partExtent(ctx.placements.find((placement) => placement.part === previousId)?.pins ?? {});
    return !previous || (from > previous.rows[0] && from - previous.rows[1] <= GROUP_GAP);
  }
  const anchor = ctx.groupAnchor[group];
  if (anchor && Math.max(from - anchor[1], anchor[0] - to, 0) > GROUP_GAP) return false;
  const half = ctx.groupHalf[group];
  return !(half && extent.side !== "both" && extent.side !== half);
}

function place(ctx: Ctx, part: Part): void {
  const constrained = ctx.groupSpans.length > 0;
  const group = ctx.groupOfPart.get(part.id);
  const anchor = group === undefined ? undefined : ctx.groupAnchor[group];
  // Within a group, closer is better: pull each part against its anchor (beats the header-row pull).
  const closeness = anchor
    ? (pins: Record<string, HoleId>) => {
        const [from, to] = partExtent(pins)?.rows ?? [0, 0];
        return Math.max(from - anchor[1], anchor[0] - to, 0) * 0.5;
      }
    : undefined;
  const clear = (pins: Record<string, HoleId>) => {
    const extent = partExtent(pins);
    return !extent || ctx.keepOut.every(([from, to]) => extent.rows[1] < from - 1 || extent.rows[0] > to + 1);
  };
  const accept = constrained || ctx.keepOut.length > 0 ? (pins: Record<string, HoleId>) => clear(pins) && (!constrained || groupAllows(ctx, part, pins)) : undefined;
  const chosen = search(ctx, part, accept, closeness) ?? (accept ? search(ctx, part, ctx.keepOut.length > 0 ? clear : undefined) : undefined) ?? (ctx.keepOut.length > 0 ? search(ctx, part) : undefined);
  if (!chosen) throw new LayoutFitError(`No room for ${part.id} (${MODULES[part.module].name}) on the ${ctx.profile.name}.`, true);
  commit(ctx, part, chosen.pins, chosen.covered, chosen.body);
}

/** Records a part at its holes: strips claimed for its nets, rail legs noted, its group's extent updated. */
function commit(ctx: Ctx, part: Part, pins: Record<string, HoleId>, covered: HoleId[], body: DrawingBox): void {
  for (const [pin, hole] of Object.entries(pins)) {
    occupy(ctx, hole, `${part.id}.${pin}`);
    const net = ctx.pinNet.get(`${part.id}.${pin}`)!;
    if (parseHole(hole)?.kind === "rail") ctx.railPinNets.add(net);
    else claimStrip(ctx, groupOf(ctx, hole), net);
  }
  for (const hole of covered) occupy(ctx, hole, `body:${part.id}`);
  ctx.placements.push({ part: part.id, pins });
  ctx.bodies.push(body);
  const group = ctx.groupOfPart.get(part.id);
  const extent = partExtent(pins);
  if (group !== undefined && extent) {
    const span = ctx.groupSpans[group];
    ctx.groupSpans[group] = span ? [Math.min(span[0], extent.rows[0]), Math.max(span[1], extent.rows[1])] : extent.rows;
    if (ctx.circuit.placement?.groups[group]?.[0] === part.id) ctx.groupAnchor[group] = extent.rows;
    if (extent.side !== "both") ctx.groupHalf[group] ??= extent.side;
  }
}

/** Cheapest legal position for `part` (optionally also passing `accept`), or undefined. */
function search(ctx: Ctx, part: Part, accept?: (pins: Record<string, HoleId>) => boolean, extraCost?: (pins: Record<string, HoleId>) => number): Candidate | undefined {
  let best: Candidate | undefined;
  const consider = (pins: Record<string, HoleId>, slots: Slot[], spanPenalty: number) => {
    const base = slotCost(ctx, slots, spanPenalty);
    const cost = base === undefined ? undefined : base + (extraCost?.(pins) ?? 0);
    if (cost === undefined || (best && cost >= best.cost - 1e-9)) return;
    if (accept && !accept(pins)) return;
    const body = partDrawingBox(ctx.profile.id, part, pins);
    if (ctx.strategy.spread) {
      const margin = 4;
      for (const other of ctx.bodies) {
        if (body.left < other.right + margin && other.left < body.right + margin && body.top < other.bottom + margin && other.top < body.bottom + margin) return;
      }
    }
    best = { pins, covered: slots.filter((entry) => entry.net === undefined).map((entry) => entry.hole), body, cost };
  };
  const rows = ctx.profile.rows;
  const variant = partVariant(part)?.footprint;
  if (MODULES[part.module].footprint.kind === "button4" && variant?.kind !== "button2") {
    // Legs 1–2 straddle the channel on one row, legs 3–4 `span` rows further; the body covers the rows between (and,
    // for a wide button whose legs sit in d/g, the channel-side e/f holes of its rows).
    const [left, right] = variant?.kind === "button4" ? variant.columns : (["e", "f"] as const);
    const span = variant?.kind === "button4" ? variant.rowSpan : 2;
    for (let base = 1; base + span <= rows; base += 1) {
      for (const flip of [false, true]) {
        const first = flip ? base + span : base;
        const second = flip ? base : base + span;
        const pins = { "1": `${left}${first}`, "2": `${right}${first}`, "3": `${left}${second}`, "4": `${right}${second}` };
        const slots = [slot(ctx, part, left, first, "1"), slot(ctx, part, right, first, "2"), slot(ctx, part, left, second, "3"), slot(ctx, part, right, second, "4")];
        for (let row = base; row <= base + span; row += 1) {
          if (row !== first && row !== second) slots.push(slot(ctx, part, left, row), slot(ctx, part, right, row));
          if (left !== "e") slots.push(slot(ctx, part, "e", row), slot(ctx, part, "f", row));
        }
        consider(pins, slots, (flip ? 0.01 : 0) + base * 0.02);
      }
    }
  } else {
    for (const shape of footprintShapes(part)) {
      const extent = shape.offsets.at(-1)!;
      for (const side of ["left", "right"] as const) {
        PART_COLUMNS[side].forEach((column, columnIndex) => {
          for (let base = 1; base + extent <= rows; base += 1) {
            const pins: Record<string, HoleId> = {};
            const slots: Slot[] = [];
            shape.pins.forEach((pin, index) => {
              const entry = slot(ctx, part, column, base + shape.offsets[index]!, pin);
              pins[pin] = entry.hole;
              slots.push(entry);
            });
            for (let row = base + 1; row < base + extent; row += 1) if (!shape.offsets.includes(row - base)) slots.push(slot(ctx, part, column, row));
            consider(pins, slots, shape.spanPenalty + base * 0.02 + columnIndex * 0.01);
          }
        });
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Repeated units (design philosophy rule 2): every copy gets the same tile, one after another at a fixed pitch.
//
// Chain tile at column c (Arduino pin → part → part → rail): the first part straddles the centre channel (its signal
// leg in f{c}, the other in e{c}), the second runs from a{c} straight into the rail hole of column c, and the Arduino
// wire lands in j{c}: short, parallel, nothing doubles back. Button tile: legs straddle the channel at columns c and
// c+span, signal pair first. A composite copy (a placement group of whole units) lays its units out in the order the
// group lists them, one free column apart.

interface Tile {
  part: Part;
  pins: Record<string, HoleId>;
  covered: HoleId[];
}

function unitWidth(ctx: Ctx, unit: Unit): number {
  if (unit.kind === "chain") return 1;
  const variant = partVariant(ctx.circuit.parts.find((part) => part.id === unit.members[0]!.part)!)?.footprint;
  return (variant?.kind === "button4" ? variant.rowSpan : 2) + 1;
}

function copyWidth(ctx: Ctx, copy: UnitCopy): number {
  return copy.units.reduce((sum, unit) => sum + unitWidth(ctx, unit), 0) + copy.units.length - 1;
}

/** Holes of one unit with its leftmost column at `column`, or undefined when they are not all free and valid. */
function unitTiles(ctx: Ctx, unit: Unit, column: number): Tile[] | undefined {
  const partOf = (id: string) => ctx.circuit.parts.find((part) => part.id === id)!;
  const tiles: Tile[] = [];
  if (unit.kind === "chain") {
    const rail = ctx.railOf.get(unit.railNet);
    if (!rail || !rail.startsWith("T") || !ctx.profile.railPositions.includes(column)) return undefined;
    const [first, second] = unit.members as [UnitMember, UnitMember];
    tiles.push({ part: partOf(first.part), pins: { [first.enter]: `f${column}`, [first.exit]: `e${column}` }, covered: [] });
    tiles.push({ part: partOf(second.part), pins: { [second.enter]: `a${column}`, [second.exit]: `${rail}${column}` }, covered: [] });
  } else {
    const member = unit.members[0]!;
    const part = partOf(member.part);
    const variant = partVariant(part)?.footprint;
    const [left, right] = variant?.kind === "button4" ? variant.columns : (["e", "f"] as const);
    const span = variant?.kind === "button4" ? variant.rowSpan : 2;
    const pairs = MODULES.button.internallyConnected ?? [];
    const enter = pairs.find((pair) => pair.includes(member.enter));
    const exit = pairs.find((pair) => pair !== enter);
    if (!enter || !exit) return undefined;
    const covered: HoleId[] = [];
    for (let row = column; row <= column + span; row += 1) {
      if (row !== column && row !== column + span) covered.push(`${left}${row}`, `${right}${row}`);
      if (left !== "e") covered.push(`e${row}`, `f${row}`);
    }
    tiles.push({ part, pins: { [enter[0]!]: `${left}${column}`, [enter[1]!]: `${right}${column}`, [exit[0]!]: `${left}${column + span}`, [exit[1]!]: `${right}${column + span}` }, covered });
  }
  for (const tile of tiles) {
    for (const [pin, hole] of Object.entries(tile.pins)) {
      if (!isValidHole(ctx.profile, hole) || ctx.occupied.has(hole)) return undefined;
      if (parseHole(hole)?.kind !== "terminal") continue;
      const owner = ctx.stripNet.get(groupOf(ctx, hole));
      if (owner !== undefined && owner !== ctx.pinNet.get(`${tile.part.id}.${pin}`)) return undefined;
    }
    for (const hole of tile.covered) if (!isValidHole(ctx.profile, hole) || ctx.occupied.has(hole)) return undefined;
  }
  return tiles;
}

function copyTiles(ctx: Ctx, copy: UnitCopy, column: number): Tile[] | undefined {
  const tiles: Tile[] = [];
  let at = column;
  for (const unit of copy.units) {
    const unitTilesAt = unitTiles(ctx, unit, at);
    if (!unitTilesAt) return undefined;
    tiles.push(...unitTilesAt);
    at += unitWidth(ctx, unit) + 1;
  }
  return tiles;
}

/** Start columns where every copy fits, best first: copies close to their Arduino pins (short, parallel wires). */
function setAnchors(ctx: Ctx, set: UnitSet, pitch: number): number[] {
  const options: { anchor: number; cost: number }[] = [];
  const span = (set.copies.length - 1) * pitch + copyWidth(ctx, set.copies.at(-1)!) - 1;
  for (let anchor = 1; anchor + span <= ctx.profile.rows; anchor += 1) {
    // Another set's copies keep two free columns between them (outputs apart from inputs).
    if (ctx.keepOut.some(([from, to]) => anchor <= to + 3 && anchor + span >= from - 3)) continue;
    let cost = anchor * 0.001;
    let fits = true;
    set.copies.forEach((copy, index) => {
      const column = anchor + index * pitch;
      if (!fits || !copyTiles(ctx, copy, column)) {
        fits = false;
        return;
      }
      let at = column;
      for (const unit of copy.units) {
        const home = ctx.homeRow.get(unit.signalNet);
        if (home !== undefined) cost += Math.abs(at - home);
        at += unitWidth(ctx, unit) + 1;
      }
    });
    if (fits) options.push({ anchor, cost });
  }
  return options.sort((a, b) => a.cost - b.cost).map((option) => option.anchor);
}

/** Builds a set's copies at a fixed pitch from its `rank`-th best start column; false when it doesn't fit. */
function placeSet(ctx: Ctx, set: UnitSet, rank: number): boolean {
  const width = Math.max(...set.copies.map((copy) => copyWidth(ctx, copy)));
  // One free column between copies at least; two for single-column copies, so 5 mm LEDs and labels don't touch.
  for (const pitch of width === 1 ? [3, 2] : [width + 1, width + 2]) {
    const anchors = setAnchors(ctx, set, pitch);
    if (anchors.length === 0) continue;
    const anchor = anchors[Math.min(rank, anchors.length - 1)]!;
    set.copies.forEach((copy, index) => {
      for (const tile of copyTiles(ctx, copy, anchor + index * pitch)!) commit(ctx, tile.part, tile.pins, tile.covered, partDrawingBox(ctx.profile.id, tile.part, tile.pins));
    });
    ctx.keepOut.push([anchor, anchor + (set.copies.length - 1) * pitch + copyWidth(ctx, set.copies.at(-1)!) - 1]);
    return true;
  }
  return false;
}

/** Parts connected by signal nets are placed back to back, starting from the Arduino pins in pin order. */
function placementOrder(ctx: Ctx): Part[] {
  const byId = new Map(ctx.circuit.parts.map((part) => [part.id, part]));
  // Placement groups first, in the order listed (left to right): each group's anchor, then its other parts with
  // resistors last (their span stretches to fit, so the parts the person asked about get the spots next to the anchor).
  const first = ctx.groupSpans.length > 0
    ? (ctx.circuit.placement?.groups ?? []).flatMap((group) => {
        const [anchor, ...others] = group.flatMap((id) => byId.get(id) ?? []);
        return anchor ? [anchor, ...others.filter((part) => part.module !== "resistor"), ...others.filter((part) => part.module === "resistor")] : [];
      })
    : [];
  const rest = connectedOrder(ctx).filter((part) => !first.includes(part));
  return [...first, ...rest];
}

function connectedOrder(ctx: Ctx): Part[] {
  const parts = [...ctx.circuit.parts].sort((a, b) => a.id.localeCompare(b.id));
  if (!ctx.strategy.grouped) return parts;
  const signalNets = ctx.circuit.nets.filter((net) => net.kind === "signal");
  const seeds = signalNets
    .flatMap((net) => net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ({ net, rank: boardPinRank(ref.pin) })))
    .sort((a, b) => a.rank - b.rank || a.net.id.localeCompare(b.net.id));
  const order: Part[] = [];
  const seen = new Set<string>();
  const visit = (start: Part) => {
    const queue = [start];
    seen.add(start.id);
    while (queue.length > 0) {
      const part = queue.shift()!;
      order.push(part);
      const neighbours = signalNets
        .filter((net) => net.pins.some((ref) => ref.part === part.id))
        .flatMap((net) => net.pins.map((ref) => ref.part))
        .filter((id) => id !== BOARD_PART && !seen.has(id))
        .sort();
      for (const id of [...new Set(neighbours)]) {
        seen.add(id);
        queue.push(parts.find((candidate) => candidate.id === id)!);
      }
    }
  };
  for (const seed of seeds) {
    for (const ref of seed.net.pins) {
      const part = parts.find((candidate) => candidate.id === ref.part);
      if (part && !seen.has(part.id)) visit(part);
    }
  }
  for (const part of parts) if (!seen.has(part.id)) visit(part);
  return order;
}

// ---------------------------------------------------------------------------------------------------------------
// Board

/** Nano: the board straddles the channel; used header rows belong to their pin's net, unused rows are blocked. */
function reserveNano(ctx: Ctx): void {
  const board = BOARD_PROFILES[ctx.circuit.board.profile];
  if (board.placement !== "straddle") return;
  const topRow = ctx.profile.rows <= 30 ? 1 : 2;
  const columns: [Column, Column] = ["e", "f"];
  ctx.boardAnchor = { topRow, columns };
  const netOfBoardPin = new Map<string, string>();
  for (const net of ctx.circuit.nets) for (const ref of net.pins) if (ref.part === BOARD_PART) netOfBoardPin.set(ref.pin, net.id);
  (board.headers[0]?.pins ?? []).forEach((pin, index) => {
    const column = index < 15 ? columns[0] : columns[1];
    const hole = `${column}${topRow + (index < 15 ? index : 29 - index)}`;
    if (!isValidHole(ctx.profile, hole)) return;
    occupy(ctx, hole, `board:${pin}`);
    const net = netOfBoardPin.get(pin);
    claimStrip(ctx, groupOf(ctx, hole), net ?? "__board");
    if (net !== undefined) ctx.headerHoles.set(pin, [...(ctx.headerHoles.get(pin) ?? []), hole]);
  });
}

function assignRails(ctx: Ctx): void {
  const rails = powerRails(ctx.profile);
  for (const net of ctx.circuit.nets) {
    const boardPins = net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin).sort((a, b) => boardPinRank(a) - boardPinRank(b));
    const home = boardPins.map((pin) => headerRow(ctx.profile.id, ctx.circuit.board.profile, pin, ctx.strategy.orientation)).find((row) => row !== undefined);
    if (home !== undefined && net.kind === "signal") ctx.homeRow.set(net.id, home);
    if (!rails) continue;
    if (net.kind === "power" && boardPins.includes("5V") && !ctx.railOf.has(net.id)) ctx.railOf.set(net.id, rails.plus);
    if (net.kind === "ground" && boardPins.includes("GND") && !ctx.railOf.has(net.id)) ctx.railOf.set(net.id, rails.minus);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Connectivity: one spanning tree of jumpers per net

type Island =
  | { kind: "strip"; side: Side; row: number }
  | { kind: "rail"; rail: RailId }
  | { kind: "board"; pin: string };

interface Node {
  island: Island;
  capacity: number;
}

function islandKey(island: Island): string {
  return island.kind === "strip" ? stripId(island.side, island.row) : island.kind === "rail" ? island.rail : `board:${island.pin}`;
}

/** Rough drawing position (x = row, y = column index; rails above, Arduino header below). */
function islandPoint(ctx: Ctx, island: Island, near?: number): { x: number; y: number } {
  if (island.kind === "strip") return { x: island.row, y: island.side === "left" ? 2 : 7 };
  if (island.kind === "rail") return { x: near ?? 1, y: -2 };
  return { x: headerRow(ctx.profile.id, ctx.circuit.board.profile, island.pin, ctx.strategy.orientation) ?? 1, y: 13 };
}

function railHoles(ctx: Ctx, rail: RailId): HoleId[] {
  return ctx.profile.railPositions.map((position) => `${rail}${position}`).filter((hole) => !ctx.occupied.has(hole));
}

function capacity(ctx: Ctx, island: Island, usedBoardPins: Set<string>): number {
  if (island.kind === "strip") return freeHoles(ctx, island.side, island.row).length;
  if (island.kind === "rail") return railHoles(ctx, island.rail).length;
  return usedBoardPins.has(island.pin) ? 0 : 1;
}

function endpointFor(ctx: Ctx, island: Island, towardRow: number): Endpoint {
  if (island.kind === "board") return { board: island.pin };
  if (island.kind === "rail") {
    const hole = railHoles(ctx, island.rail).sort((a, b) => Math.abs(holeRow(a) - towardRow) - Math.abs(holeRow(b) - towardRow) || holeRow(a) - holeRow(b))[0];
    if (!hole) throw new LayoutFitError(`The ${island.rail} rail has no free holes left.`, true);
    return { hole };
  }
  const hole = freeHoles(ctx, island.side, island.row)[0];
  if (!hole) throw new LayoutFitError(`Strip ${stripId(island.side, island.row)} has no free hole for a jumper.`, true);
  return { hole };
}

function jumperPhase(from: Island, to: Island): number {
  const kinds = new Set([from.kind, to.kind]);
  if (kinds.has("board") && kinds.has("rail")) return 0;
  if (kinds.has("board")) return 1;
  if (kinds.has("rail")) return 2;
  return 3;
}

/** A fresh strip for `net` near `row` (a hub when the net's islands have run out of free holes). */
function hubStrip(ctx: Ctx, net: string, row: number): Island {
  const options: { side: Side; row: number }[] = [];
  for (let candidate = 1; candidate <= ctx.profile.rows; candidate += 1) {
    for (const side of ["left", "right"] as const) {
      if (ctx.stripNet.has(stripId(side, candidate))) continue;
      if (freeHoles(ctx, side, candidate).length < 3) continue;
      options.push({ side, row: candidate });
    }
  }
  const best = options.sort((a, b) => Math.abs(a.row - row) - Math.abs(b.row - row) || a.row - b.row || a.side.localeCompare(b.side))[0];
  if (!best) throw new LayoutFitError(`No spare strip is left to join the pieces of net ${net}.`, true);
  claimStrip(ctx, stripId(best.side, best.row), net);
  return { kind: "strip", side: best.side, row: best.row };
}

function connectNet(ctx: Ctx, netId: string): void {
  const net = ctx.circuit.nets.find((entry) => entry.id === netId);
  const islands = new Map<string, Island>();
  for (const [group, owner] of ctx.stripNet) {
    if (owner !== netId) continue;
    const match = /^r(\d+):(a-e|f-j)$/.exec(group)!;
    const island: Island = { kind: "strip", side: match[2] === "a-e" ? "left" : "right", row: Number(match[1]) };
    islands.set(islandKey(island), island);
  }
  const rail = ctx.railOf.get(netId);
  const hasPartPins = islands.size > 0 || ctx.railPinNets.has(netId);
  if (rail && hasPartPins) islands.set(rail, { kind: "rail", rail });
  const boardPins = [...new Set(net?.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin) ?? [])];
  for (const pin of boardPins) {
    // Nano header pins sit in their strip already; the Uno is off-board and needs a wire.
    if (ctx.headerHoles.has(pin)) continue;
    islands.set(`board:${pin}`, { kind: "board", pin });
  }
  if (islands.size < 2) return;

  // Islands already joined: button pairs through the part, Nano header strips of the same pin through the board.
  const parent = new Map<string, string>([...islands.keys()].map((key) => [key, key]));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const placement of ctx.placements) {
    const part = ctx.circuit.parts.find((candidate) => candidate.id === placement.part)!;
    for (const group of MODULES[part.module].internallyConnected ?? []) {
      const keys = group.map((pin) => placement.pins[pin]).filter((hole): hole is HoleId => hole !== undefined).map((hole) => groupOf(ctx, hole));
      for (const key of keys.slice(1)) if (islands.has(key) && islands.has(keys[0]!)) union(key, keys[0]!);
    }
  }
  for (const holes of ctx.headerHoles.values()) {
    const keys = holes.map((hole) => groupOf(ctx, hole)).filter((key) => islands.has(key));
    for (const key of keys.slice(1)) union(key, keys[0]!);
  }

  const usedBoardPins = new Set<string>();
  const connect = (from: Island, to: Island) => {
    const fromRow = from.kind === "strip" ? from.row : 1;
    const toRow = to.kind === "strip" ? to.row : fromRow;
    const a = endpointFor(ctx, from, toRow);
    const b = endpointFor(ctx, to, "hole" in a ? holeRow(a.hole) : fromRow);
    if (from.kind === "board") usedBoardPins.add(from.pin);
    if (to.kind === "board") usedBoardPins.add(to.pin);
    // Wires start at the Arduino (or the rail) so the build reads source → destination.
    const [first, second] = to.kind === "board" || (to.kind === "rail" && from.kind === "strip") ? [b, a] : [a, b];
    addJumper(ctx, first, second, netId, jumperPhase(from, to));
    union(islandKey(from), islandKey(to));
  };

  if (rail && islands.has(rail)) {
    // Split rails: one bridge wire across the gap makes both halves one rail (built with the rails, before any part).
    const bridge = railBridge(ctx.profile, rail);
    if (bridge) {
      if (bridge.some((hole) => ctx.occupied.has(hole))) throw new LayoutFitError(`The ${rail} rail's bridge holes ${bridge.join(" and ")} are taken.`, true);
      addJumper(ctx, { hole: bridge[0] }, { hole: bridge[1] }, netId, 0);
    }
  }
  // The Arduino's 5 V / GND header always feeds its rail first (the "rails" build step).
  if (rail && islands.has(rail)) {
    const pin = rail.endsWith("+") ? "5V" : "GND";
    if (islands.has(`board:${pin}`)) {
      const home = headerRow(ctx.profile.id, ctx.circuit.board.profile, pin, ctx.strategy.orientation) ?? 1;
      const hole = railHoles(ctx, rail).sort((a, b) => Math.abs(holeRow(a) - home) - Math.abs(holeRow(b) - home) || holeRow(a) - holeRow(b))[0];
      if (!hole) throw new LayoutFitError(`The ${rail} rail has no free holes left.`, true);
      addJumper(ctx, { board: pin }, { hole }, netId, 0);
      usedBoardPins.add(pin);
      union(`board:${pin}`, rail);
    }
  }

  const nodes = () => [...islands.values()].map((island) => ({ island, capacity: capacity(ctx, island, usedBoardPins) } satisfies Node));
  const rootKey = find(boardPins.length > 0 && islands.has(`board:${boardPins[0]}`) ? `board:${boardPins[0]}` : rail && islands.has(rail) ? rail : [...islands.keys()].sort()[0]!);
  for (;;) {
    const all = nodes();
    const tree = all.filter((node) => find(islandKey(node.island)) === find(rootKey));
    const rest = all.filter((node) => find(islandKey(node.island)) !== find(rootKey));
    if (rest.length === 0) return;
    let best: { from: Node; to: Node; cost: number } | undefined;
    for (const from of tree) {
      if (from.capacity < 1) continue;
      for (const to of rest) {
        if (to.capacity < 1) continue;
        // Power and ground strips take their own wire from the rail (the familiar breadboard pattern) rather than
        // daisy-chaining through each other.
        const viaRail = from.island.kind === "rail" || to.island.kind === "rail";
        const toPoint = islandPoint(ctx, to.island);
        const fromPoint = islandPoint(ctx, from.island, toPoint.x);
        const cost = viaRail ? 0.5 + Math.abs(fromPoint.y - toPoint.y) * 0.1 : Math.hypot(fromPoint.x - toPoint.x, (fromPoint.y - toPoint.y) * 1.5);
        if (!best || cost < best.cost - 1e-9) best = { from, to, cost };
      }
    }
    if (!best) throw new LayoutFitError(`Net ${netId} cannot be joined: its pieces have no free holes for jumpers.`, true);
    const treeCapacity = tree.reduce((sum, node) => sum + node.capacity, 0);
    const restComponents = new Set(rest.map((node) => find(islandKey(node.island)))).size;
    const joinedCapacity = rest.filter((node) => find(islandKey(node.island)) === find(islandKey(best!.to.island))).reduce((sum, node) => sum + node.capacity, 0);
    if (restComponents > 1 && treeCapacity - 1 + joinedCapacity - 1 < 1) {
      // Joining would leave the tree without a free hole for the remaining pieces: branch through a hub strip.
      const row = best.from.island.kind === "strip" ? best.from.island.row : best.to.island.kind === "strip" ? best.to.island.row : 1;
      const hub = hubStrip(ctx, netId, row);
      islands.set(islandKey(hub), hub);
      parent.set(islandKey(hub), islandKey(hub));
      connect(best.from.island, hub);
      continue;
    }
    connect(best.from.island, best.to.island);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

function attempt(circuit: Circuit, profile: BreadboardProfile, strategy: Strategy, sets: UnitSet[]): Layout {
  const pinNet = buildPinNets(circuit);
  const ctx: Ctx = {
    circuit,
    profile,
    strategy,
    pinNet,
    colors: defaultNetColors(circuit),
    stripNet: new Map(),
    occupied: new Map(),
    freeCount: new Map(),
    netRows: new Map(),
    placements: [],
    bodies: [],
    groupOfPart: new Map(),
    groupSpans: [],
    groupAnchor: [],
    groupHalf: [],
    jumpers: [],
    railOf: new Map(),
    headerHoles: new Map(),
    homeRow: new Map(),
    railPinNets: new Set(),
    keepOut: [],
  };
  if (strategy.placementGroups) {
    (circuit.placement?.groups ?? []).forEach((group, index) => {
      for (const id of group) ctx.groupOfPart.set(id, index);
      ctx.groupSpans.push(undefined);
      ctx.groupAnchor.push(undefined);
      ctx.groupHalf.push(undefined);
    });
  }
  reserveNano(ctx);
  assignRails(ctx);
  if (strategy.repeats) {
    sets.forEach((set, index) => placeSet(ctx, set, index === 0 ? strategy.repeats!.anchorRank : 0));
    if (ctx.keepOut.length === 0) throw new LayoutFitError("No repeated units could be built as identical copies.", true);
  }
  const placed = new Set(ctx.placements.map((placement) => placement.part));
  for (const part of placementOrder(ctx)) if (!placed.has(part.id)) place(ctx, part);
  // Nano header jumpers tie the board pin to its header hole (how LVS sees a plugged-in pin).
  for (const [pin, holes] of [...ctx.headerHoles].sort(([a], [b]) => a.localeCompare(b))) {
    const net = circuit.nets.find((entry) => entry.pins.some((ref) => ref.part === BOARD_PART && ref.pin === pin))!;
    for (const hole of holes) ctx.jumpers.push({ phase: 1, jumper: { id: "", from: { board: pin }, to: { hole }, color: wireColor(ctx, net.id), net: net.id } });
  }
  for (const net of [...circuit.nets].sort((a, b) => a.id.localeCompare(b.id))) connectNet(ctx, net.id);
  // A split rail's bridge stays only when the rail's other wires really use both halves.
  const railHalves = (rail: string, except: Jumper) =>
    new Set([
      ...ctx.jumpers.filter((entry) => entry.jumper !== except).flatMap(({ jumper }) => [jumper.from, jumper.to]).flatMap((end) => ("hole" in end ? [end.hole] : [])),
      ...ctx.placements.flatMap((placement) => Object.values(placement.pins)),
    ].filter((hole) => hole.startsWith(rail)).map((hole) => groupOf(ctx, hole)));
  ctx.jumpers = ctx.jumpers.filter(({ jumper }) => !isRailBridge(profile, jumper) || railHalves("hole" in jumper.from ? jumper.from.hole.slice(0, 2) : "", jumper).size > 1);
  ctx.jumpers.sort((a, b) => a.phase - b.phase || a.jumper.net.localeCompare(b.jumper.net) || endpointKey(a.jumper.from).localeCompare(endpointKey(b.jumper.from)) || endpointKey(a.jumper.to).localeCompare(endpointKey(b.jumper.to)));
  return {
    schema: "vibread.layout/1",
    board: circuit.board.profile,
    breadboard: circuit.breadboard.profile,
    placements: ctx.placements.sort((a, b) => a.part.localeCompare(b.part)),
    jumpers: ctx.jumpers.map((entry, index) => ({ ...entry.jumper, id: `W${index + 1}` })),
    ...(ctx.boardAnchor ? { boardAnchor: ctx.boardAnchor } : {}),
    ...(BOARD_PROFILES[circuit.board.profile].placement !== "straddle" ? { boardOrientation: strategy.orientation } : {}),
  };
}

/** How the allocator chose a layout: every candidate it tried, and why the winner won (for the mission log). */
export interface LayoutDecision {
  chosen: string;
  reason: string;
  candidates: { label: string; ok: boolean; unmet?: number; score?: number; crossings?: number; wires?: number; problem?: string }[];
}

function strategyLabel(strategy: Strategy, uno: boolean): string {
  const facing = uno ? `, Uno USB ${strategy.orientation === "usb-right" ? "right" : "left"}` : "";
  if (strategy.repeats) return `repeated units as identical copies (start column option ${strategy.repeats.anchorRank + 1}${strategy.spread ? "" : ", tight"}${facing})`;
  return `packing (reserve ${strategy.reserve}${strategy.spread ? ", spread" : ""}${strategy.grouped ? ", connected parts together" : ""}${strategy.placementGroups ? ", placement groups" : ""}${facing})`;
}

/**
 * Deterministic breadboard layout whose LVS is clean, scored by the design philosophy (quality.ts). Hard constraints:
 * LVS clean and every explicit placement request met; among the candidates that satisfy them the lowest quality score
 * wins (fewest wires, no crossings, regular repeated units, short wires). Candidates: repeated units built as
 * identical copies (a few start columns), then the plain packings. When no candidate meets every placement request,
 * the one with the fewest unmet requests is returned and the assembly console fails it (PLACEMENT-UNMET).
 * Throws `LayoutFitError` when nothing fits (tool-side unless the design contradicts itself).
 */
export function layoutBoard(circuit: Circuit): Layout {
  return layoutWithDecision(circuit).layout;
}

export function layoutWithDecision(circuit: Circuit): { layout: Layout; decision: LayoutDecision } {
  const profile = BREADBOARD_PROFILES[circuit.breadboard.profile];
  if (!profile) throw new LayoutFitError(`Unknown breadboard profile ${circuit.breadboard.profile}.`, true);
  if (!BOARD_PROFILES[circuit.board.profile]) throw new LayoutFitError(`Unknown board profile ${circuit.board.profile}.`, true);
  const failures: string[] = [];
  const sets = repeatedUnits(circuit);
  const grouped = (circuit.placement?.groups.length ?? 0) > 0;
  // An Uno below the breadboard can face either way (USB end left or right); a Nano sits on the breadboard.
  const orientations: BoardOrientation[] = BOARD_PROFILES[circuit.board.profile].placement === "straddle" ? ["usb-left"] : ["usb-left", "usb-right"];
  const tiled: Strategy[] = sets.length > 0 ? orientations.flatMap((orientation) => [0, 1, 2].map((anchorRank) => ({ orientation, reserve: 1, spread: true, grouped: true, placementGroups: grouped, repeats: { anchorRank } }))) : [];
  const packings: Strategy[] = orientations.flatMap((orientation) => [
    ...(grouped ? PACKINGS.map((packing) => ({ ...packing, orientation, placementGroups: true })) : []),
    ...PACKINGS.map((packing) => ({ ...packing, orientation, placementGroups: false })),
  ]);
  const candidates: { layout: Layout; unmet: number; quality: LayoutQuality; label: string }[] = [];
  const tried: LayoutDecision["candidates"] = [];
  const run = (strategy: Strategy): (typeof candidates)[number] | undefined => {
    const label = strategyLabel(strategy, orientations.length > 1);
    try {
      const layout = attempt(circuit, profile, strategy, sets);
      const result = lvs(circuit, layout);
      if (!result.ok) {
        const problem = result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("; ");
        failures.push(problem);
        tried.push({ label, ok: false, problem });
        return undefined;
      }
      const quality = layoutQuality(circuit, layout);
      const unmet = grouped ? placementSummary(circuit, layout, quality).groups.filter((group) => !group.met).length : 0;
      const entry = { layout, unmet, quality, label };
      candidates.push(entry);
      tried.push({ label, ok: true, unmet, score: quality.score, crossings: quality.crossings, wires: quality.wires });
      return entry;
    } catch (error) {
      if (error instanceof LayoutFitError && !error.toolSide) throw error;
      const problem = error instanceof Error ? error.message : String(error);
      // The plain packings' reasons explain a no-fit better than "no copies fit".
      if (!strategy.repeats) failures.push(problem);
      tried.push({ label, ok: false, problem });
      return undefined;
    }
  };
  for (const strategy of tiled) run(strategy);
  if (tiled.length > 0 && !candidates.some((entry) => entry.unmet === 0)) for (const orientation of orientations) run({ ...tiled[0]!, orientation, spread: false });
  // The plain packings. When identical copies already meet every request, each orientation's first good packing is
  // enough to compare against (trying them all costs seconds on big designs and rarely wins); otherwise the score
  // picks among all of them (fewer crossings, fewer and shorter wires).
  const tiledOk = candidates.some((entry) => entry.unmet === 0);
  for (const orientation of orientations) {
    for (const strategy of packings.filter((entry) => entry.orientation === orientation)) {
      const entry = run(strategy);
      if (tiledOk && entry && entry.unmet === 0) break;
    }
  }
  if (candidates.length === 0) {
    const reason = [...new Set(failures)].slice(0, 2).join(" / ");
    throw new LayoutFitError(`ViBread could not fit this circuit on the ${profile.name}: ${reason}`, true);
  }
  const best = [...candidates].sort((a, b) => a.unmet - b.unmet || a.quality.score - b.quality.score)[0]!;
  const repeats = best.quality.repeats.filter((entry) => entry.regular).map((entry) => `${entry.copies.map((copy) => copy.join("+")).join(", ")} every ${entry.pitch} columns`);
  const reason = [
    best.unmet > 0 ? `no candidate met every placement request (${best.unmet} unmet); this one misses the fewest` : grouped ? "meets every placement request" : "",
    `score ${best.quality.score}: ${best.quality.wires} wires, ${best.quality.crossings} crossing${best.quality.crossings === 1 ? "" : "s"}, ${best.quality.irregular} irregular repeat${best.quality.irregular === 1 ? "" : "s"}`,
    repeats.length > 0 ? `identical copies: ${repeats.join("; ")}` : "",
  ].filter(Boolean).join("; ");
  return { layout: best.layout, decision: { chosen: best.label, reason, candidates: tried } };
}

export function layoutHash(layout: Layout): string {
  return hashJson(layout);
}
