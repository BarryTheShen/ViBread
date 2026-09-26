/**
 * ViBread schematic drawing: ELK layered layout (elkjs) with orthogonal routing and fixed port positions, then a
 * self-contained dark SVG in the conventions `../src/schematic/check.ts` validates.
 *
 * - The Arduino is one box: signal pins on its left/right edges in pin order, used power pins on top, GND below.
 * - Every part is one ELK node that holds its symbol, its labels, and a local 5V/GND symbol on each power pin, so
 *   labels and power symbols are obstacles the layout knows about. Signal pins are the node's ports.
 * - Circuits flow away from the board: inputs to the left of the Arduino, outputs to the right; two-terminal parts are
 *   horizontal with the board-facing terminal toward the Arduino (resistors land inline between pin and LED).
 * - Every signal net is real wire from ELK's router; junction dots mark every branch.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import {
  BOARD_PART,
  BOARD_PROFILES,
  formatOhms,
  modulePins,
  pinKey,
  wireCss,
  type Circuit,
  type Net,
  type Part,
} from "@vibread/core";
import { junctionPoints, textBox, textWidth, type Box, type Pt, type TextAnchor } from "../src/schematic/check.js";
import { netColors } from "../src/layout/colors.js";

const FONT_FAMILY = "DejaVu Sans, Verdana, Arial, Helvetica, sans-serif";
const COLORS = {
  background: "#0b1220",
  body: "#172033",
  outline: "#93c5fd",
  lead: "#5eead4",
  reference: "#f8fafc",
  value: "#fde68a",
  note: "#94a3b8",
  pinName: "#a7f3d0",
  power: "#fda4af",
  title: "#a7f3d0",
} as const;

const LED_FILL: Record<string, string> = {
  red: "#f87171",
  yellow: "#facc15",
  green: "#4ade80",
  blue: "#60a5fa",
  white: "#f8fafc",
  orange: "#fb923c",
  pink: "#f472b6",
  purple: "#c084fc",
  "warm-white": "#fef3c7",
};

const REF_SIZE = 15;
const VALUE_SIZE = 13;
const NOTE_SIZE = 12;
const PIN_SIZE = 13;
const POWER_SIZE = 12;
const BOARD_PITCH = 34;
const MIN_LEAD = 14;
const NODE_MARGIN = 6;

type Side = "WEST" | "EAST" | "NORTH" | "SOUTH";

type Prim =
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; cls?: string; pin?: string; stroke?: string; width?: number }
  | { t: "poly"; pts: Pt[]; closed: boolean; fill?: string; stroke?: string; width?: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string }
  | { t: "circle"; cx: number; cy: number; r: number; fill?: string; stroke?: string }
  | { t: "text"; x: number; y: number; text: string; size: number; anchor: TextAnchor; bold?: boolean; fill: string };

/** A drawing group: the part itself or one power symbol hanging off one of its pins. */
interface Group {
  attrs: Record<string, string>;
  prims: Prim[];
}

interface Port {
  key: string;
  side: Side;
  x: number;
  y: number;
}

/** One ELK node in local coordinates (0,0 = node top-left once `finish` ran). */
interface NodeDrawing {
  id: string;
  groups: Group[];
  ports: Port[];
  width: number;
  height: number;
}

interface Topology {
  netOf: Map<string, Net>;
  /** Signal-net hops from the nearest board pin (board pins are 0). */
  dist: Map<string, number>;
  /** Side of the Arduino the part's circuit sits on. */
  side: Map<string, "WEST" | "EAST">;
  boardSide: Map<string, "WEST" | "EAST">;
  order: Map<string, number>;
}

// ---------------------------------------------------------------------------------------------------------------
// Topology: sides, distances, orientation

function boardPinRank(pin: string): number {
  const number = Number(pin.slice(1));
  if (/^D\d+$/.test(pin)) return number;
  if (/^A\d+$/.test(pin)) return 100 + number;
  return 200;
}

function topology(circuit: Circuit): Topology {
  const netOf = new Map<string, Net>();
  for (const net of circuit.nets) for (const ref of net.pins) netOf.set(pinKey(ref), net);
  const signalNets = circuit.nets.filter((net) => net.kind === "signal");

  // Connected components of parts over signal nets.
  const parent = new Map<string, string>(circuit.parts.map((part) => [part.id, part.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const net of signalNets) {
    const parts = net.pins.filter((ref) => ref.part !== BOARD_PART).map((ref) => ref.part);
    for (const other of parts.slice(1)) parent.set(find(other), find(parts[0]!));
  }
  const componentPins = new Map<string, string[]>();
  for (const net of signalNets) {
    const boardPins = net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin);
    const part = net.pins.find((ref) => ref.part !== BOARD_PART);
    if (!part || boardPins.length === 0) continue;
    const root = find(part.part);
    componentPins.set(root, [...(componentPins.get(root) ?? []), ...boardPins]);
  }

  // Inputs to the left of the board, outputs to the right; a component follows the majority of its board pins.
  const roleOf = new Map(circuit.roles.map((role) => [role.pin, role.mode]));
  const componentSide = new Map<string, "WEST" | "EAST">();
  const roots = [...new Set(circuit.parts.map((part) => find(part.id)))];
  for (const root of roots) {
    let vote = 0;
    for (const pin of componentPins.get(root) ?? []) {
      const mode = roleOf.get(pin);
      if (mode === "OUTPUT" || mode === "PWM_OUT") vote += 1;
      else if (mode) vote -= 1;
      else vote += pin.startsWith("A") ? -1 : 1;
    }
    componentSide.set(root, vote < 0 ? "WEST" : "EAST");
  }
  // Keep the Arduino from growing tall on one side: move the last circuits (by pin order) across when one side
  // carries more than three board pins over the other.
  const pinCount = (which: "WEST" | "EAST") => roots.filter((root) => componentSide.get(root) === which).reduce((sum, root) => sum + (componentPins.get(root)?.length ?? 0), 0);
  const firstPin = (root: string) => Math.min(...(componentPins.get(root) ?? []).map(boardPinRank), 1000);
  for (;;) {
    const heavy = pinCount("EAST") >= pinCount("WEST") ? "EAST" : "WEST";
    const light = heavy === "EAST" ? "WEST" : "EAST";
    const movable = roots.filter((root) => componentSide.get(root) === heavy && (componentPins.get(root)?.length ?? 0) > 0).sort((a, b) => firstPin(b) - firstPin(a))[0];
    if (!movable) break;
    const moved = componentPins.get(movable)!.length;
    if (pinCount(heavy) - pinCount(light) <= 3 || pinCount(light) + moved >= pinCount(heavy)) break;
    componentSide.set(movable, light);
  }
  const side = new Map<string, "WEST" | "EAST">();
  const boardSide = new Map<string, "WEST" | "EAST">();
  const order = new Map<string, number>();
  for (const part of circuit.parts) {
    const root = find(part.id);
    const partSide = componentSide.get(root)!;
    side.set(part.id, partSide);
    for (const pin of componentPins.get(root) ?? []) boardSide.set(pin, partSide);
    order.set(part.id, firstPin(root));
  }
  // Board signal pins whose net has no part (board-to-board jumpers) still need a side.
  for (const net of signalNets) {
    for (const ref of net.pins) if (ref.part === BOARD_PART && !boardSide.has(ref.pin)) boardSide.set(ref.pin, ref.pin.startsWith("A") ? "WEST" : "EAST");
  }

  // Breadth-first hops from the board; components without a board pin start from their first part.
  const dist = new Map<string, number>([[BOARD_PART, 0]]);
  const queue: string[] = [BOARD_PART];
  const expand = () => {
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const net of signalNets) {
        if (!net.pins.some((ref) => ref.part === current)) continue;
        for (const ref of net.pins) {
          if (dist.has(ref.part)) continue;
          dist.set(ref.part, dist.get(current)! + 1);
          queue.push(ref.part);
        }
      }
    }
  };
  expand();
  for (const part of circuit.parts) {
    if (dist.has(part.id)) continue;
    dist.set(part.id, 1);
    queue.push(part.id);
    expand();
  }
  return { netOf, dist, side, boardSide, order };
}

/** Signal pins of `part` that face the Arduino: their net reaches the board or a part closer to it. */
function facingPins(part: Part, topo: Topology): Set<string> {
  const own = topo.dist.get(part.id) ?? 1;
  const facing = new Set<string>();
  for (const pin of modulePins(part)) {
    const net = topo.netOf.get(`${part.id}.${pin.id}`);
    if (!net || net.kind !== "signal") continue;
    if (net.pins.some((ref) => ref.part !== part.id && (topo.dist.get(ref.part) ?? own) < own)) facing.add(pin.id);
  }
  return facing;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing helpers

function mirrorPrim(prim: Prim): Prim {
  switch (prim.t) {
    case "line":
      return { ...prim, x1: -prim.x1, x2: -prim.x2 };
    case "poly":
      return { ...prim, pts: prim.pts.map((p) => ({ x: -p.x, y: p.y })) };
    case "rect":
      return { ...prim, x: -(prim.x + prim.w) };
    case "circle":
      return { ...prim, cx: -prim.cx };
    case "text":
      return { ...prim, x: -prim.x, anchor: prim.anchor === "start" ? "end" : prim.anchor === "end" ? "start" : "middle" };
  }
}

function primBox(prim: Prim): Box {
  switch (prim.t) {
    case "line":
      return { left: Math.min(prim.x1, prim.x2), top: Math.min(prim.y1, prim.y2), right: Math.max(prim.x1, prim.x2), bottom: Math.max(prim.y1, prim.y2) };
    case "poly":
      return {
        left: Math.min(...prim.pts.map((p) => p.x)),
        top: Math.min(...prim.pts.map((p) => p.y)),
        right: Math.max(...prim.pts.map((p) => p.x)),
        bottom: Math.max(...prim.pts.map((p) => p.y)),
      };
    case "rect":
      return { left: prim.x, top: prim.y, right: prim.x + prim.w, bottom: prim.y + prim.h };
    case "circle":
      return { left: prim.cx - prim.r, top: prim.cy - prim.r, right: prim.cx + prim.r, bottom: prim.cy + prim.r };
    case "text":
      return textBox(prim.x, prim.y, prim.text, prim.size, prim.anchor, prim.bold);
  }
}

function arrowHead(tip: Pt, from: Pt, size = 5): Prim {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const wing = (offset: number) => ({ x: tip.x - size * Math.cos(angle + offset), y: tip.y - size * Math.sin(angle + offset) });
  return { t: "poly", pts: [wing(0.5), tip, wing(-0.5)], closed: false };
}

function truncate(text: string, max = 28): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function powerName(net: Net): string {
  const boardPower = net.pins.find((ref) => ref.part === BOARD_PART);
  return net.kind === "ground" ? net.id : boardPower?.pin ?? net.id;
}

/** Local 5V/GND symbol whose stub starts at the pin's connection point. */
function powerGroup(pin: string, net: Net, at: Pt): Group {
  const name = powerName(net);
  const prims: Prim[] = [];
  if (net.kind === "ground") {
    prims.push({ t: "line", x1: at.x, y1: at.y, x2: at.x, y2: at.y + 12, cls: "stub", stroke: COLORS.power });
    prims.push({ t: "line", x1: at.x - 10, y1: at.y + 12, x2: at.x + 10, y2: at.y + 12, stroke: COLORS.power });
    prims.push({ t: "line", x1: at.x - 6, y1: at.y + 16, x2: at.x + 6, y2: at.y + 16, stroke: COLORS.power });
    prims.push({ t: "line", x1: at.x - 2, y1: at.y + 20, x2: at.x + 2, y2: at.y + 20, stroke: COLORS.power });
    prims.push({ t: "text", x: at.x, y: at.y + 34, text: name, size: POWER_SIZE, anchor: "middle", fill: COLORS.power });
  } else {
    prims.push({ t: "line", x1: at.x, y1: at.y, x2: at.x, y2: at.y - 12, cls: "stub", stroke: COLORS.power });
    prims.push({ t: "line", x1: at.x - 9, y1: at.y - 12, x2: at.x + 9, y2: at.y - 12, stroke: COLORS.power });
    prims.push({ t: "text", x: at.x, y: at.y - 18, text: name, size: POWER_SIZE, anchor: "middle", bold: true, fill: COLORS.power });
  }
  return { attrs: { class: "power", "data-net": net.id, "data-pin": pin }, prims };
}

function partValue(part: Part): string {
  switch (part.module) {
    case "resistor":
    case "potentiometer":
      return typeof part.params.ohms === "number" ? formatOhms(part.params.ohms) : "";
    case "led":
      return typeof part.params.color === "string" ? part.params.color : "red";
    case "photoresistor":
      return "light sensor";
    case "buzzer-active":
      return "active buzzer";
    case "buzzer-passive":
      return "passive buzzer";
    case "button":
    case "generic":
      return "";
  }
}

/** Label lines: reference + value on the first line, the plain-language label (except resistors) below. */
function labelLines(part: Part): { ref: string; value: string; note: string } {
  const value = partValue(part);
  const note = part.module === "resistor" || !part.label ? "" : truncate(part.label);
  return { ref: part.id, value, note: note.toLowerCase() === value.toLowerCase() ? "" : note };
}

function labelWidth(lines: { ref: string; value: string; note: string }): number {
  const first = textWidth(lines.ref, REF_SIZE, true) + (lines.value ? 7 + textWidth(lines.value, VALUE_SIZE) : 0);
  return Math.max(first, lines.note ? textWidth(lines.note, NOTE_SIZE) : 0);
}

/**
 * Label block whose last line's box bottom sits at `bottom`. `align` places the block relative to `x`.
 * Returns the prims (reference bold, value yellow, note grey).
 */
function labelBlock(lines: { ref: string; value: string; note: string }, x: number, bottom: number, align: TextAnchor): Prim[] {
  const width = labelWidth(lines);
  const left = align === "start" ? x : align === "middle" ? x - width / 2 : x - width;
  const prims: Prim[] = [];
  let baseline = bottom - 0.26 * (lines.note ? NOTE_SIZE : REF_SIZE);
  if (lines.note) {
    const noteWidth = textWidth(lines.note, NOTE_SIZE);
    const noteLeft = align === "middle" ? x - noteWidth / 2 : align === "start" ? left : left + width - noteWidth;
    prims.push({ t: "text", x: noteLeft, y: baseline, text: lines.note, size: NOTE_SIZE, anchor: "start", fill: COLORS.note });
    baseline -= NOTE_SIZE * 1.3;
  }
  const firstWidth = textWidth(lines.ref, REF_SIZE, true) + (lines.value ? 7 + textWidth(lines.value, VALUE_SIZE) : 0);
  const firstLeft = align === "middle" ? x - firstWidth / 2 : align === "start" ? left : left + width - firstWidth;
  prims.push({ t: "text", x: firstLeft, y: baseline, text: lines.ref, size: REF_SIZE, anchor: "start", bold: true, fill: COLORS.reference });
  if (lines.value) {
    prims.push({ t: "text", x: firstLeft + textWidth(lines.ref, REF_SIZE, true) + 7, y: baseline, text: lines.value, size: VALUE_SIZE, anchor: "start", fill: COLORS.value });
  }
  return prims;
}

/**
 * Close a node: extend each port's lead to the node border (so ELK's port sits on the boundary), shift to a
 * top-left origin, and record the size.
 */
function finishNode(id: string, groups: Group[], portStubs: { key: string; side: Side; from: Pt }[]): NodeDrawing {
  const all = groups.flatMap((group) => group.prims);
  const boxes = [...all.map(primBox), ...portStubs.map((stub) => ({ left: stub.from.x, right: stub.from.x, top: stub.from.y, bottom: stub.from.y }))];
  const content = {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
  const box = {
    left: Math.min(content.left - NODE_MARGIN, ...portStubs.filter((s) => s.side === "WEST").map((s) => s.from.x - MIN_LEAD)),
    right: Math.max(content.right + NODE_MARGIN, ...portStubs.filter((s) => s.side === "EAST").map((s) => s.from.x + MIN_LEAD)),
    top: Math.min(content.top - NODE_MARGIN, ...portStubs.filter((s) => s.side === "NORTH").map((s) => s.from.y - MIN_LEAD)),
    bottom: Math.max(content.bottom + NODE_MARGIN, ...portStubs.filter((s) => s.side === "SOUTH").map((s) => s.from.y + MIN_LEAD)),
  };
  box.left = Math.floor(box.left);
  box.top = Math.floor(box.top);
  box.right = Math.ceil(box.right);
  box.bottom = Math.ceil(box.bottom);
  const partGroup = groups[0]!;
  const ports: Port[] = [];
  for (const stub of portStubs) {
    const end = stub.side === "WEST" ? { x: box.left, y: stub.from.y }
      : stub.side === "EAST" ? { x: box.right, y: stub.from.y }
      : stub.side === "NORTH" ? { x: stub.from.x, y: box.top }
      : { x: stub.from.x, y: box.bottom };
    partGroup.prims.push({ t: "line", x1: stub.from.x, y1: stub.from.y, x2: end.x, y2: end.y, cls: "lead", pin: stub.key });
    ports.push({ key: stub.key, side: stub.side, x: end.x - box.left, y: end.y - box.top });
  }
  const shift = (prim: Prim): Prim => {
    const dx = -box.left;
    const dy = -box.top;
    switch (prim.t) {
      case "line":
        return { ...prim, x1: prim.x1 + dx, y1: prim.y1 + dy, x2: prim.x2 + dx, y2: prim.y2 + dy };
      case "poly":
        return { ...prim, pts: prim.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      case "rect":
        return { ...prim, x: prim.x + dx, y: prim.y + dy };
      case "circle":
        return { ...prim, cx: prim.cx + dx, cy: prim.cy + dy };
      case "text":
        return { ...prim, x: prim.x + dx, y: prim.y + dy };
    }
  };
  return {
    id,
    groups: groups.map((group) => ({ attrs: group.attrs, prims: group.prims.map(shift) })),
    ports,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Part symbols (canonical: first terminal on the left, board to the left)

interface TwoTerminalSymbol {
  prims: Prim[];
  /** Terminal points: [left, right]. */
  ends: [Pt, Pt];
}

function resistorSymbol(): TwoTerminalSymbol {
  const pts: Pt[] = [{ x: -20, y: 0 }];
  for (let index = 0; index < 8; index += 1) pts.push({ x: -17.5 + index * 5, y: index % 2 === 0 ? -7 : 7 });
  pts.push({ x: 20, y: 0 });
  return { prims: [{ t: "poly", pts, closed: false }], ends: [{ x: -20, y: 0 }, { x: 20, y: 0 }] };
}

function ledSymbol(color: string): TwoTerminalSymbol {
  const fill = LED_FILL[color] ?? "#f8fafc";
  const prims: Prim[] = [
    { t: "poly", pts: [{ x: -9, y: -9 }, { x: -9, y: 9 }, { x: 7, y: 0 }], closed: true, fill },
    { t: "line", x1: 7, y1: -9, x2: 7, y2: 9 },
  ];
  for (const [x, y] of [[-2, -11], [4, -11]] as const) {
    const tip = { x: x + 7, y: y - 7 };
    prims.push({ t: "line", x1: x, y1: y, x2: tip.x, y2: tip.y });
    prims.push(arrowHead(tip, { x, y }, 4));
  }
  return { prims, ends: [{ x: -9, y: 0 }, { x: 7, y: 0 }] };
}

function photoresistorSymbol(): TwoTerminalSymbol {
  const base = resistorSymbol();
  for (const x of [-12, -2]) {
    const from = { x, y: -24 };
    const tip = { x: x + 7, y: -11 };
    base.prims.push({ t: "line", x1: from.x, y1: from.y, x2: tip.x, y2: tip.y });
    base.prims.push(arrowHead(tip, from, 4));
  }
  return base;
}

function buttonSymbol(): TwoTerminalSymbol {
  return {
    prims: [
      { t: "circle", cx: -13, cy: 0, r: 2.5, fill: "none" },
      { t: "circle", cx: 13, cy: 0, r: 2.5, fill: "none" },
      { t: "line", x1: -15, y1: -8, x2: 15, y2: -8 },
      { t: "line", x1: 0, y1: -8, x2: 0, y2: -16 },
      { t: "line", x1: -6, y1: -16, x2: 6, y2: -16 },
    ],
    ends: [{ x: -15.5, y: 0 }, { x: 15.5, y: 0 }],
  };
}

function buzzerSymbol(): TwoTerminalSymbol {
  return {
    prims: [
      { t: "rect", x: -17, y: -11, w: 34, h: 22, fill: COLORS.body },
      { t: "circle", cx: 7, cy: 0, r: 5, fill: "none" },
      { t: "text", x: -8, y: 4.5, text: "+", size: 13, anchor: "middle", bold: true, fill: COLORS.power },
    ],
    ends: [{ x: -17, y: 0 }, { x: 17, y: 0 }],
  };
}

/** Terminal pin ids in canonical left/right order. The button's pairs (1–2, 3–4) are one terminal each. */
function terminals(part: Part): [string[], string[]] {
  switch (part.module) {
    case "led":
      return [["A"], ["K"]];
    case "buzzer-active":
    case "buzzer-passive":
      return [["P"], ["N"]];
    case "button":
      return [["1", "2"], ["3", "4"]];
    default:
      return [["1"], ["2"]];
  }
}

function twoTerminalNode(part: Part, topo: Topology): NodeDrawing {
  const symbol = part.module === "resistor" ? resistorSymbol()
    : part.module === "led" ? ledSymbol(typeof part.params.color === "string" ? part.params.color : "red")
    : part.module === "photoresistor" ? photoresistorSymbol()
    : part.module === "button" ? buttonSymbol()
    : buzzerSymbol();
  const [firstPins, secondPins] = terminals(part);
  const facing = facingPins(part, topo);
  const boardOnLeft = topo.side.get(part.id) !== "WEST";
  const netFor = (pin: string) => topo.netOf.get(`${part.id}.${pin}`);
  // Which terminal faces the Arduino. Ties keep the canonical order (anode / + / pin 1 toward the board).
  const firstFacing = firstPins.some((pin) => facing.has(pin));
  const secondFacing = secondPins.some((pin) => facing.has(pin));
  const firstIsPowered = firstPins.some((pin) => netFor(pin) && netFor(pin)!.kind !== "signal");
  const swap = (secondFacing && !firstFacing) || (!firstFacing && !secondFacing && firstIsPowered);
  const facingTerminal = swap ? secondPins : firstPins;
  const farTerminal = swap ? firstPins : secondPins;
  // Canonical symbol has its first terminal on the left; mirror when the facing terminal must be on the right.
  const facingOnLeft = boardOnLeft;
  const mirror = (swap ? 1 : 0) ^ (facingOnLeft ? 0 : 1);
  let prims = symbol.prims.map((prim) => ({ ...prim }) as Prim);
  let ends = symbol.ends;
  if (mirror) {
    prims = prims.map(mirrorPrim);
    ends = [{ x: -symbol.ends[1].x, y: 0 }, { x: -symbol.ends[0].x, y: 0 }];
  }
  const sideTerminals: { pins: string[]; end: Pt; dir: -1 | 1 }[] = [
    { pins: facingOnLeft ? facingTerminal : farTerminal, end: ends[0], dir: -1 },
    { pins: facingOnLeft ? farTerminal : facingTerminal, end: ends[1], dir: 1 },
  ];
  prims = prims.map((prim) => (prim.t === "text" ? prim : { ...prim, stroke: COLORS.outline }) as Prim);

  const lines = labelLines(part);
  const bodyTop = Math.min(...prims.map((prim) => primBox(prim).top));
  const width = labelWidth(lines);
  const labelPrims = labelBlock(lines, 0, bodyTop - 5, "middle");
  const partGroup: Group = { attrs: { class: "part", "data-part": part.id }, prims: [...prims, ...labelPrims] };
  const groups: Group[] = [partGroup];
  const stubs: { key: string; side: Side; from: Pt }[] = [];
  for (const terminal of sideTerminals) {
    const used = terminal.pins.filter((pin) => netFor(pin));
    const drawn = used.length > 0 ? used : [terminal.pins[0]!];
    drawn.forEach((pin, index) => {
      const key = `${part.id}.${pin}`;
      const net = netFor(pin);
      const y = index * 22;
      const from = { x: terminal.end.x, y: 0 };
      if (index > 0) {
        // Second leg of a button terminal: a short joiner down to its own lead.
        partGroup.prims.push({ t: "line", x1: from.x, y1: 0, x2: from.x + terminal.dir * 8, y2: 0, stroke: COLORS.lead });
        partGroup.prims.push({ t: "line", x1: from.x + terminal.dir * 8, y1: 0, x2: from.x + terminal.dir * 8, y2: y, stroke: COLORS.lead });
        from.x += terminal.dir * 8;
        from.y = y;
      }
      if (net && net.kind === "signal") {
        stubs.push({ key, side: terminal.dir < 0 ? "WEST" : "EAST", from });
        return;
      }
      let length = 16;
      if (net && net.kind === "power") {
        // Keep the upward 5V symbol clear of the label block above the body.
        const clearance = width / 2 + 10 + Math.max(10, textWidth(powerName(net), POWER_SIZE, true) / 2);
        length = Math.max(length, clearance - Math.abs(from.x));
      }
      const at = { x: from.x + terminal.dir * length, y: from.y };
      partGroup.prims.push({ t: "line", x1: from.x, y1: from.y, x2: at.x, y2: at.y, cls: "lead", pin: key });
      if (net) groups.push(powerGroup(key, net, at));
    });
  }
  return finishNode(part.id, groups, stubs);
}

/** Vertical potentiometer: power end on top, ground end at the bottom, wiper arrow from the Arduino's side. */
function potentiometerNode(part: Part, topo: Topology): NodeDrawing {
  const netFor = (pin: string) => topo.netOf.get(`${part.id}.${pin}`);
  const aNet = netFor("A");
  const bNet = netFor("B");
  const flip = aNet?.kind === "ground" || bNet?.kind === "power";
  const top = flip ? "B" : "A";
  const bottom = flip ? "A" : "B";
  const pts: Pt[] = [{ x: 0, y: -20 }];
  for (let index = 0; index < 8; index += 1) pts.push({ x: index % 2 === 0 ? 7 : -7, y: -17.5 + index * 5 });
  pts.push({ x: 0, y: 20 });
  const prims: Prim[] = [
    { t: "poly", pts, closed: false, stroke: COLORS.outline },
    { t: "line", x1: -24, y1: 0, x2: -9, y2: 0, stroke: COLORS.outline },
    { ...arrowHead({ x: -9, y: 0 }, { x: -24, y: 0 }), stroke: COLORS.outline } as Prim,
  ];
  const lines = labelLines(part);
  const labelHeight = lines.note ? REF_SIZE * 1.1 + NOTE_SIZE * 1.3 : REF_SIZE * 1.1;
  const boardOnLeft = topo.side.get(part.id) !== "WEST";
  const canonical = boardOnLeft ? prims : prims.map(mirrorPrim);
  // The label goes on the side away from the wiper, aligned to the symbol (never mirrored text order).
  canonical.push(...labelBlock(lines, boardOnLeft ? 16 : -16, labelHeight / 2, boardOnLeft ? "start" : "end"));
  const partGroup: Group = { attrs: { class: "part", "data-part": part.id }, prims: canonical };
  const groups: Group[] = [partGroup];
  const stubs: { key: string; side: Side; from: Pt }[] = [];
  const place = (pin: string, from: Pt, dir: Pt, side: Side) => {
    const key = `${part.id}.${pin}`;
    const net = netFor(pin);
    if (net?.kind === "signal") {
      stubs.push({ key, side, from });
      return;
    }
    const at = { x: from.x + dir.x * 12, y: from.y + dir.y * 12 };
    partGroup.prims.push({ t: "line", x1: from.x, y1: from.y, x2: at.x, y2: at.y, cls: "lead", pin: key });
    if (net) groups.push(powerGroup(key, net, at));
  };
  place(top, { x: 0, y: -20 }, { x: 0, y: -1 }, "NORTH");
  place(bottom, { x: 0, y: 20 }, { x: 0, y: 1 }, "SOUTH");
  place("W", { x: boardOnLeft ? -24 : 24, y: 0 }, { x: boardOnLeft ? -1 : 1, y: 0 }, boardOnLeft ? "WEST" : "EAST");
  return finishNode(part.id, groups, stubs);
}

/** Generic part: a box with signal pins facing the Arduino, power pins on top, ground pins below. */
function genericNode(part: Part, topo: Topology): NodeDrawing {
  const netFor = (pin: string) => topo.netOf.get(`${part.id}.${pin}`);
  const facing = facingPins(part, topo);
  const pins = modulePins(part);
  const near = pins.filter((pin) => facing.has(pin.id));
  const far = pins.filter((pin) => !facing.has(pin.id) && (netFor(pin.id)?.kind ?? "signal") === "signal");
  const up = pins.filter((pin) => netFor(pin.id)?.kind === "power");
  const down = pins.filter((pin) => netFor(pin.id)?.kind === "ground");
  const lines = labelLines(part);
  const header = [
    { text: part.id, size: REF_SIZE, bold: true, fill: COLORS.reference },
    ...(lines.note ? [{ text: lines.note, size: NOTE_SIZE, bold: false, fill: COLORS.note }] : []),
  ];
  const nameWidth = (list: typeof pins) => Math.max(0, ...list.map((pin) => textWidth(pin.id, PIN_SIZE)));
  const pitch = 26;
  const width = Math.ceil(Math.max(
    ...header.map((line) => textWidth(line.text, line.size, line.bold) + 24),
    nameWidth(near) + nameWidth(far) + 40,
    Math.max(up.length, down.length) * 40 + 20,
    80,
  ));
  const headerHeight = 12 + header.length * 18;
  const rows = Math.max(near.length, far.length, 1);
  const height = headerHeight + rows * pitch + 8;
  const prims: Prim[] = [{ t: "rect", x: 0, y: 0, w: width, h: height, fill: COLORS.body, stroke: COLORS.outline }];
  header.forEach((line, index) => {
    prims.push({ t: "text", x: width / 2, y: 22 + index * 18, text: line.text, size: line.size, anchor: "middle", bold: line.bold, fill: line.fill });
  });
  const stubs: { key: string; side: Side; from: Pt }[] = [];
  const leads: { key: string; from: Pt; to: Pt; net: Net | undefined }[] = [];
  const rowY = (index: number) => headerHeight + pitch / 2 + index * pitch;
  near.forEach((pin, index) => {
    prims.push({ t: "text", x: 7, y: rowY(index) + 4.5, text: pin.id, size: PIN_SIZE, anchor: "start", fill: COLORS.pinName });
    stubs.push({ key: `${part.id}.${pin.id}`, side: "WEST", from: { x: 0, y: rowY(index) } });
  });
  far.forEach((pin, index) => {
    prims.push({ t: "text", x: width - 7, y: rowY(index) + 4.5, text: pin.id, size: PIN_SIZE, anchor: "end", fill: COLORS.pinName });
    const net = netFor(pin.id);
    if (net) stubs.push({ key: `${part.id}.${pin.id}`, side: "EAST", from: { x: width, y: rowY(index) } });
    else leads.push({ key: `${part.id}.${pin.id}`, from: { x: width, y: rowY(index) }, to: { x: width + 10, y: rowY(index) }, net });
  });
  const spread = (count: number, index: number) => width / 2 + (index - (count - 1) / 2) * 40;
  up.forEach((pin, index) => leads.push({ key: `${part.id}.${pin.id}`, from: { x: spread(up.length, index), y: 0 }, to: { x: spread(up.length, index), y: -14 }, net: netFor(pin.id) }));
  down.forEach((pin, index) => leads.push({ key: `${part.id}.${pin.id}`, from: { x: spread(down.length, index), y: height }, to: { x: spread(down.length, index), y: height + 14 }, net: netFor(pin.id) }));
  const boardOnLeft = topo.side.get(part.id) !== "WEST";
  const mirrorAll = (list: Prim[]) => (boardOnLeft ? list : list.map(mirrorPrim));
  const partGroup: Group = { attrs: { class: "part", "data-part": part.id }, prims: mirrorAll(prims) };
  const groups: Group[] = [partGroup];
  const flipPt = (p: Pt) => (boardOnLeft ? p : { x: -p.x, y: p.y });
  for (const lead of leads) {
    const from = flipPt(lead.from);
    const to = flipPt(lead.to);
    partGroup.prims.push({ t: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y, cls: "lead", pin: lead.key });
    if (lead.net) groups.push(powerGroup(lead.key, lead.net, to));
  }
  const flipSide = (side: Side): Side => (boardOnLeft ? side : side === "WEST" ? "EAST" : side === "EAST" ? "WEST" : side);
  return finishNode(part.id, groups, stubs.map((stub) => ({ ...stub, side: flipSide(stub.side), from: flipPt(stub.from) })));
}

/** The Arduino: pin names inside the box, signal pins left/right in pin order, power on top, ground below. */
function boardNode(circuit: Circuit, topo: Topology): NodeDrawing {
  const used = new Map<string, Net>();
  for (const net of circuit.nets) for (const ref of net.pins) if (ref.part === BOARD_PART) used.set(ref.pin, net);
  const signalPins = [...used].filter(([, net]) => net.kind === "signal").map(([pin]) => pin).sort((a, b) => boardPinRank(a) - boardPinRank(b) || a.localeCompare(b));
  const left = signalPins.filter((pin) => topo.boardSide.get(pin) === "WEST");
  const right = signalPins.filter((pin) => topo.boardSide.get(pin) !== "WEST");
  const top = [...used].filter(([, net]) => net.kind === "power").map(([pin]) => pin);
  const bottom = [...used].filter(([, net]) => net.kind === "ground").map(([pin]) => pin);
  // "Arduino Uno R3 (ATmega328P)" → "Arduino Uno R3"
  const title = BOARD_PROFILES[circuit.board.profile].name.replace(/\s*\(.*\)\s*$/, "");
  const nameWidth = (list: string[]) => Math.max(0, ...list.map((pin) => textWidth(pin, PIN_SIZE)));
  const width = Math.ceil(Math.max(170, textWidth(title, 16, true) + 36, nameWidth(left) + nameWidth(right) + 60, Math.max(top.length, bottom.length) * 56 + 24));
  const topNames = top.length > 0 ? 24 : 0;
  const titleY = topNames + 28;
  const firstRow = titleY + 30;
  const rows = Math.max(left.length, right.length, 1);
  const height = firstRow + (rows - 1) * BOARD_PITCH + (bottom.length > 0 ? 40 : 22);
  const prims: Prim[] = [
    { t: "rect", x: 0, y: 0, w: width, h: height, fill: COLORS.body, stroke: COLORS.outline },
    { t: "text", x: width / 2, y: titleY, text: title, size: 16, anchor: "middle", bold: true, fill: COLORS.title },
  ];
  const group: Group = { attrs: { class: "part", "data-part": BOARD_PART }, prims };
  const groups: Group[] = [group];
  const stubs: { key: string; side: Side; from: Pt }[] = [];
  left.forEach((pin, index) => {
    const y = firstRow + index * BOARD_PITCH;
    prims.push({ t: "text", x: 9, y: y + 4.5, text: pin, size: PIN_SIZE, anchor: "start", bold: true, fill: COLORS.pinName });
    stubs.push({ key: `${BOARD_PART}.${pin}`, side: "WEST", from: { x: 0, y } });
  });
  right.forEach((pin, index) => {
    const y = firstRow + index * BOARD_PITCH;
    prims.push({ t: "text", x: width - 9, y: y + 4.5, text: pin, size: PIN_SIZE, anchor: "end", bold: true, fill: COLORS.pinName });
    stubs.push({ key: `${BOARD_PART}.${pin}`, side: "EAST", from: { x: width, y } });
  });
  const spread = (count: number, index: number) => width / 2 + (index - (count - 1) / 2) * 56;
  top.forEach((pin, index) => {
    const x = spread(top.length, index);
    prims.push({ t: "text", x, y: 18, text: pin, size: PIN_SIZE, anchor: "middle", bold: true, fill: COLORS.pinName });
    const at = { x, y: -16 };
    prims.push({ t: "line", x1: x, y1: 0, x2: at.x, y2: at.y, cls: "lead", pin: `${BOARD_PART}.${pin}` });
    groups.push(powerGroup(`${BOARD_PART}.${pin}`, used.get(pin)!, at));
  });
  bottom.forEach((pin, index) => {
    const x = spread(bottom.length, index);
    prims.push({ t: "text", x, y: height - 10, text: pin, size: PIN_SIZE, anchor: "middle", bold: true, fill: COLORS.pinName });
    const at = { x, y: height + 16 };
    prims.push({ t: "line", x1: x, y1: height, x2: at.x, y2: at.y, cls: "lead", pin: `${BOARD_PART}.${pin}` });
    groups.push(powerGroup(`${BOARD_PART}.${pin}`, used.get(pin)!, at));
  });
  for (const prim of prims) if (prim.t === "line" && prim.cls === "lead") prim.stroke = COLORS.lead;
  return finishNode("board", groups, stubs);
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
  "elk.spacing.nodeNode": "36",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "14",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.layered.mergeEdges": "true",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "48",
};

function portId(key: string): string {
  return `p:${key}`;
}

interface Placed {
  node: NodeDrawing;
  x: number;
  y: number;
}

function buildEdges(circuit: Circuit, topo: Topology): ElkExtendedEdge[] {
  const edges: ElkExtendedEdge[] = [];
  const distOf = (part: string) => topo.dist.get(part) ?? 1;
  for (const net of circuit.nets) {
    if (net.kind !== "signal") continue;
    const endpoints = net.pins.map((ref) => ({ key: pinKey(ref), part: ref.part, d: ref.part === BOARD_PART ? 0 : distOf(ref.part) }));
    const sorted = [...endpoints].sort((a, b) => a.d - b.d);
    const min = sorted[0]!.d;
    const max = sorted[sorted.length - 1]!.d;
    const root = sorted.filter((e) => e.d === min).length === 1 || sorted.filter((e) => e.d === max).length !== 1
      ? sorted[0]!
      : sorted[sorted.length - 1]!;
    const sideOf = (part: string) => (part === BOARD_PART ? undefined : topo.side.get(part));
    endpoints.forEach((endpoint, index) => {
      if (endpoint === root) return;
      const side = sideOf(endpoint.part) ?? sideOf(root.part) ?? "EAST";
      const [near, far] = endpoint.d < root.d ? [endpoint, root] : [root, endpoint];
      const [source, target] = side === "WEST" ? [far, near] : [near, far];
      edges.push({ id: `e:${net.id}:${index}`, sources: [portId(source.key)], targets: [portId(target.key)] });
    });
  }
  return edges;
}

const elk = new ELK();

interface LaidOut {
  width: number;
  height: number;
  placed: Placed[];
  wires: Map<string, Pt[][]>;
}

async function layoutSchematic(circuit: Circuit): Promise<LaidOut> {
  const topo = topology(circuit);
  const parts = [...circuit.parts].sort((a, b) => (topo.order.get(a.id)! - topo.order.get(b.id)!) || (topo.dist.get(a.id)! - topo.dist.get(b.id)!));
  const nodes: NodeDrawing[] = [];
  const west = parts.filter((part) => topo.side.get(part.id) === "WEST");
  const east = parts.filter((part) => topo.side.get(part.id) !== "WEST");
  const drawPart = (part: Part) => part.module === "potentiometer" ? potentiometerNode(part, topo)
    : part.module === "generic" ? genericNode(part, topo)
    : twoTerminalNode(part, topo);
  nodes.push(...west.map(drawPart));
  if (circuit.nets.some((net) => net.pins.some((ref) => ref.part === BOARD_PART))) nodes.push(boardNode(circuit, topo));
  nodes.push(...east.map(drawPart));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: `n:${node.id}`,
      width: node.width,
      height: node.height,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: node.ports.map((port) => ({ id: portId(port.key), x: port.x, y: port.y, width: 0, height: 0, layoutOptions: { "elk.port.side": port.side } })),
    })),
    edges: buildEdges(circuit, topo),
  };
  const result = await elk.layout(graph);
  const placed: Placed[] = nodes.map((node) => {
    const laid = result.children?.find((child) => child.id === `n:${node.id}`);
    // Integer node positions + integer port offsets keep wire ends exactly on the pins after rounding.
    return { node, x: Math.round(laid?.x ?? 0), y: Math.round(laid?.y ?? 0) };
  });
  const wires = new Map<string, Pt[][]>();
  for (const edge of (result.edges ?? []) as ElkExtendedEdge[]) {
    const netId = edge.id.split(":")[1]!;
    const list = wires.get(netId) ?? [];
    for (const section of edge.sections ?? []) {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      // Drop repeated points and merge collinear runs that rounding produced.
      const clean: Pt[] = [];
      for (const point of points) {
        const last = clean[clean.length - 1];
        if (last && last.x === point.x && last.y === point.y) continue;
        const before = clean[clean.length - 2];
        if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) clean.pop();
        clean.push(point);
      }
      list.push(clean);
    }
    wires.set(netId, list);
  }
  return { width: result.width ?? 0, height: result.height ?? 0, placed, wires };
}

// ---------------------------------------------------------------------------------------------------------------
// SVG

function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function primSvg(prim: Prim, dx: number, dy: number): string {
  const stroke = "stroke" in prim && prim.stroke ? prim.stroke : COLORS.outline;
  switch (prim.t) {
    case "line": {
      const cls = prim.cls ? ` class="${prim.cls}"` : "";
      const pin = prim.pin ? ` data-pin="${escapeXml(prim.pin)}"` : "";
      const color = prim.cls === "lead" ? COLORS.lead : stroke;
      return `<line${cls}${pin} x1="${fmt(prim.x1 + dx)}" y1="${fmt(prim.y1 + dy)}" x2="${fmt(prim.x2 + dx)}" y2="${fmt(prim.y2 + dy)}" stroke="${color}" stroke-width="${prim.width ?? 2}" stroke-linecap="round"/>`;
    }
    case "poly": {
      const points = prim.pts.map((p) => `${fmt(p.x + dx)},${fmt(p.y + dy)}`).join(" ");
      const tag = prim.closed ? "polygon" : "polyline";
      const fill = prim.closed ? prim.fill ?? "none" : "none";
      const opacity = prim.closed && prim.fill ? ` fill-opacity="0.45"` : "";
      return `<${tag} points="${points}" fill="${fill}"${opacity} stroke="${stroke}" stroke-width="${prim.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    case "rect":
      return `<rect x="${fmt(prim.x + dx)}" y="${fmt(prim.y + dy)}" width="${fmt(prim.w)}" height="${fmt(prim.h)}" rx="3" fill="${prim.fill ?? "none"}" stroke="${stroke}" stroke-width="2"/>`;
    case "circle":
      return `<circle cx="${fmt(prim.cx + dx)}" cy="${fmt(prim.cy + dy)}" r="${fmt(prim.r)}" fill="${prim.fill ?? "none"}" stroke="${stroke}" stroke-width="2"/>`;
    case "text": {
      const weight = prim.bold ? ` font-weight="bold"` : "";
      return `<text x="${fmt(prim.x + dx)}" y="${fmt(prim.y + dy)}" font-size="${prim.size}" text-anchor="${prim.anchor}"${weight} fill="${prim.fill}">${escapeXml(prim.text)}</text>`;
    }
  }
}

// The result still has to pass `checkSchematicSvg` before anyone sees it.
/**
 * Lay out and draw `circuit`. Each signal net is drawn in its build wire colour (`colors` = net id → kit name or
 * #rrggbb; defaults to the suggested colours) so the schematic and the breadboard agree.
 */
export async function drawSchematic(circuit: Circuit, colors: Record<string, string> = netColors(circuit)): Promise<string> {
  const layout = await layoutSchematic(circuit);
  const width = Math.ceil(layout.width);
  const height = Math.ceil(layout.height);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" data-schematic="drawing" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">`);
  out.push(`<title>${escapeXml(`Schematic: ${circuit.title}`)}</title>`);
  out.push(`<rect class="background" x="0" y="0" width="${width}" height="${height}" fill="${COLORS.background}"/>`);

  // Pin connection points, absolute.
  const anchors = new Map<string, Pt>();
  for (const { node, x, y } of layout.placed) {
    for (const group of node.groups) {
      for (const prim of group.prims) if (prim.t === "line" && prim.cls === "lead" && prim.pin) anchors.set(prim.pin, { x: prim.x2 + x, y: prim.y2 + y });
    }
  }
  for (const net of circuit.nets) {
    if (net.kind !== "signal") continue;
    const polylines = layout.wires.get(net.id) ?? [];
    const pins = net.pins.flatMap((ref) => anchors.get(pinKey(ref)) ?? []);
    const segments = polylines.flatMap((points) => points.slice(1).map((b, index) => ({ a: points[index]!, b })));
    const stroke = wireCss(colors[net.id] ?? "white");
    out.push(`<g class="net" data-net="${escapeXml(net.id)}">`);
    for (const points of polylines) {
      const coords = points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
      out.push(`<polyline class="wire" points="${coords}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>`);
      // Invisible wide twin so a finger or cursor can tap the net (the web picker recolours it).
      out.push(`<polyline class="wire-hit" points="${coords}" fill="none" stroke="transparent" stroke-width="14" stroke-linejoin="round"/>`);
    }
    for (const point of junctionPoints(segments, pins)) {
      out.push(`<circle class="junction" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="4" fill="${stroke}"/>`);
    }
    for (const point of pins) out.push(`<circle class="pin-end" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="2.5" fill="${stroke}"/>`);
    out.push(`</g>`);
  }
  for (const { node, x, y } of layout.placed) {
    for (const group of node.groups) {
      out.push(`<g${Object.entries(group.attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join("")}>`);
      for (const prim of group.prims) out.push(primSvg(prim, x, y));
      out.push(`</g>`);
    }
  }
  out.push(`</svg>`);
  return out.join("\n");
}

