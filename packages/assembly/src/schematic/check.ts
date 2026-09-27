/**
 * Geometry checker for ViBread schematic SVGs.
 *
 * The drawing is parsed back from its SVG (never from layout internals) and checked against the circuit IR:
 *   - every signal net is one connected wire graph that ends on each of its pins (no dangling ends, dots at every T),
 *   - every power/ground pin carries a local power symbol,
 *   - wires of different nets never touch, overlap, or pass through a pin; wires never cross a symbol,
 *   - labels overlap no other label, symbol, wire, or dot,
 *   - symbols do not overlap each other,
 *   - everything lies inside the viewBox.
 * The renderer runs it on every drawing and emits the connection table instead when it reports anything.
 *
 * SVG conventions (produced by schematic-runtime/draw.ts):
 *   <svg data-schematic="drawing" viewBox="…">
 *   <g class="part" data-part="R1">   symbol lines/polylines/polygons/rects/circles, <line class="lead" data-pin="R1.1">
 *                                      (x2,y2 is the connection point), <text> labels owned by the part
 *   <g class="power" data-net="GND" data-pin="LED1.K">  <line class="stub"> starting at the pin, symbol, label
 *   <g class="net" data-net="D4">      <polyline class="wire">, <circle class="junction"> only where 3+ wire branches meet
 *                                      (or a wire continues through a pin); a wire simply ending on a pin gets no dot
 */
import { BOARD_PART, pinKey, type Circuit } from "@vibread/core";

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Seg {
  a: Pt;
  b: Pt;
}
export interface SchematicIssue {
  code: string;
  message: string;
}

/** Coordinate tolerance (px) for "same point" and touching. */
const EPS = 0.5;
/** A crossing closer than this to a wire end or bend reads as a connection. */
const NEAR = 4;
/** Minimum clear gap (px) around every label. */
const LABEL_GAP = 1;
const MIN_FONT_PX = 10;

// ---------------------------------------------------------------------------------------------------------------
// Text metrics. Advance widths approximate DejaVu Sans (resvg's configured sans-serif) and are rounded up so that
// Verdana/Arial/Helvetica fallbacks in browsers stay inside the estimate.

const WIDTH_CLASSES: [string, number][] = [
  [" ", 0.33],
  ["il|!.,:;'`·", 0.33],
  ["fjtrI()[]{}J/\\", 0.44],
  ["mwMW%…", 1.02],
  ["-−–", 0.42],
  ["+=<>→←~", 0.86],
  ["0123456789", 0.66],
  ["ABCDEFGHKLNOPQRSTUVXYZΩ&#@", 0.8],
  ["abcdeghknopqsuvxyz?", 0.65],
];

function charWidth(char: string): number {
  for (const [chars, width] of WIDTH_CLASSES) if (chars.includes(char)) return width;
  return 0.85;
}

/** Conservative rendered width of `text` in px. */
export function textWidth(text: string, sizePx: number, bold = false): number {
  let em = 0;
  for (const char of text) em += charWidth(char);
  return em * sizePx * (bold ? 1.12 : 1) * 1.07;
}

export type TextAnchor = "start" | "middle" | "end";

/** Box of a single-line text drawn with its baseline at `y`. */
export function textBox(x: number, y: number, text: string, sizePx: number, anchor: TextAnchor, bold = false): Box {
  const width = textWidth(text, sizePx, bold);
  const left = anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width;
  return { left, top: y - sizePx * 0.84, right: left + width, bottom: y + sizePx * 0.26 };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry primitives

function samePoint(p: Pt, q: Pt, tolerance = EPS): boolean {
  return Math.abs(p.x - q.x) <= tolerance && Math.abs(p.y - q.y) <= tolerance;
}

function inflate(box: Box, by: number): Box {
  return { left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function segLength(s: Seg): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

function pointSegDistance(p: Pt, s: Seg): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - s.a.x, p.y - s.a.y);
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy));
}

/** True when the segment passes through the open interior of `box` (touching its edge does not count). */
function segIntersectsBox(s: Seg, box: Box): boolean {
  if (box.right <= box.left || box.bottom <= box.top) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const clips: [number, number][] = [
    [-dx, s.a.x - box.left],
    [dx, box.right - s.a.x],
    [-dy, s.a.y - box.top],
    [dy, box.bottom - s.a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  if (segLength(s) === 0) return t0 <= t1;
  return t1 - t0 > 1e-9;
}

type SegRelation = { kind: "none" } | { kind: "cross"; at: Pt } | { kind: "touch"; at: Pt } | { kind: "overlap" };

/**
 * How two segments meet: a proper crossing of both interiors (`cross`), contact at or near an end of either (`touch`,
 * which reads as a connection), a collinear run (`overlap`), or not at all.
 */
function segRelation(s: Seg, t: Seg, near = NEAR): SegRelation {
  const d1x = s.b.x - s.a.x;
  const d1y = s.b.y - s.a.y;
  const d2x = t.b.x - t.a.x;
  const d2y = t.b.y - t.a.y;
  const l1 = Math.hypot(d1x, d1y);
  const l2 = Math.hypot(d2x, d2y);
  const endpointContacts: Pt[] = [];
  for (const p of [t.a, t.b]) if (pointSegDistance(p, s) <= EPS) endpointContacts.push(p);
  for (const p of [s.a, s.b]) if (pointSegDistance(p, t) <= EPS) endpointContacts.push(p);
  const cross = d1x * d2y - d1y * d2x;
  if (l1 === 0 || l2 === 0 || Math.abs(cross) <= 1e-9 * l1 * l2) {
    if (endpointContacts.length === 0) return { kind: "none" };
    if (l1 > 0 && l2 > 0) {
      const ux = d1x / l1;
      const uy = d1y / l1;
      const project = (p: Pt) => (p.x - s.a.x) * ux + (p.y - s.a.y) * uy;
      const lo = Math.max(0, Math.min(project(t.a), project(t.b)));
      const hi = Math.min(l1, Math.max(project(t.a), project(t.b)));
      if (hi - lo > EPS) return { kind: "overlap" };
    }
    return { kind: "touch", at: endpointContacts[0]! };
  }
  if (endpointContacts.length > 0) return { kind: "touch", at: endpointContacts[0]! };
  const u = ((t.a.x - s.a.x) * d2y - (t.a.y - s.a.y) * d2x) / cross;
  const v = ((t.a.x - s.a.x) * d1y - (t.a.y - s.a.y) * d1x) / cross;
  if (u < 0 || u > 1 || v < 0 || v > 1) return { kind: "none" };
  const at = { x: s.a.x + u * d1x, y: s.a.y + u * d1y };
  const nearEnd = [s.a, s.b, t.a, t.b].some((p) => Math.hypot(p.x - at.x, p.y - at.y) < near);
  return nearEnd ? { kind: "touch", at } : { kind: "cross", at };
}

// ---------------------------------------------------------------------------------------------------------------
// Same-net wire graph: segments split at every end that lands on another segment, so T-contacts become graph nodes
// and collinear overlaps collapse. X crossings of two segments are not connections (schematic convention).

function pointKey(p: Pt): string {
  return `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
}

interface WireGraph {
  nodes: Map<string, { pt: Pt; degree: number }>;
  edges: [string, string][];
}

function wireGraph(segments: Seg[], anchors: Pt[]): WireGraph {
  const splitters = [...segments.flatMap((s) => [s.a, s.b]), ...anchors];
  const nodes = new Map<string, { pt: Pt; degree: number }>();
  const edgeKeys = new Set<string>();
  const edges: [string, string][] = [];
  for (const s of segments) {
    const length = segLength(s);
    if (length <= EPS) continue;
    const ts = [0, 1];
    for (const p of splitters) {
      if (pointSegDistance(p, s) > EPS) continue;
      const t = ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)) / (length * length);
      if (t * length > EPS && (1 - t) * length > EPS) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    for (let index = 1; index < ts.length; index += 1) {
      const p = { x: s.a.x + ts[index - 1]! * (s.b.x - s.a.x), y: s.a.y + ts[index - 1]! * (s.b.y - s.a.y) };
      const q = { x: s.a.x + ts[index]! * (s.b.x - s.a.x), y: s.a.y + ts[index]! * (s.b.y - s.a.y) };
      if (Math.hypot(q.x - p.x, q.y - p.y) <= EPS) continue;
      const kp = pointKey(p);
      const kq = pointKey(q);
      if (kp === kq) continue;
      const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push([kp, kq]);
      for (const [k, pt] of [[kp, p], [kq, q]] as const) {
        const node = nodes.get(k) ?? { pt, degree: 0 };
        node.degree += 1;
        nodes.set(k, node);
      }
    }
  }
  return { nodes, edges };
}

/** Points that need a junction dot: three or more wire branches meet, or a wire continues through a pin. */
export function junctionPoints(segments: Seg[], anchors: Pt[]): Pt[] {
  const graph = wireGraph(segments, anchors);
  const anchorKeys = new Set(anchors.map(pointKey));
  return [...graph.nodes.entries()]
    .filter(([key, node]) => node.degree >= 3 || (anchorKeys.has(key) && node.degree >= 2))
    .map(([, node]) => node.pt);
}

// ---------------------------------------------------------------------------------------------------------------
// SVG parsing (the renderer's flat subset)

type Shape = { type: "seg"; seg: Seg } | { type: "area"; box: Box; rect: boolean };
interface Label {
  text: string;
  box: Box;
  size: number;
  owner: string;
}
interface Item {
  id: string;
  kind: "part" | "power";
  part?: string;
  pin?: string;
  net?: string;
  shapes: Shape[];
  /** Rect edges: labels inside their own frame (Arduino pin names) are fine; crossing the frame is not. */
  outlines: Seg[];
  labels: Label[];
  leads: { pin: string; seg: Seg }[];
  stubs: Seg[];
}
interface NetDrawing {
  net: string;
  wires: Seg[];
  junctions: { at: Pt; box: Box }[];
}
export interface ParsedSchematic {
  kind: string | undefined;
  viewBox: Box | undefined;
  items: Item[];
  nets: Map<string, NetDrawing>;
  looseLabels: Label[];
}

function attrsOf(raw: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) output[match[1]!] = match[2]!;
  return output;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function num(attrs: Record<string, string>, key: string): number {
  const value = Number(attrs[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function pointsOf(attrs: Record<string, string>): Pt[] {
  const values = (attrs.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const points: Pt[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push({ x: values[index]!, y: values[index + 1]! });
  return points;
}

function boxOfPoints(points: Pt[]): Box {
  return {
    left: Math.min(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
}

function rectEdges(box: Box): Seg[] {
  const tl = { x: box.left, y: box.top };
  const tr = { x: box.right, y: box.top };
  const br = { x: box.right, y: box.bottom };
  const bl = { x: box.left, y: box.bottom };
  return [{ a: tl, b: tr }, { a: tr, b: br }, { a: br, b: bl }, { a: bl, b: tl }];
}

export function parseSchematicSvg(svg: string): ParsedSchematic {
  const rootMatch = svg.match(/<svg\b([^>]*)>/);
  const rootAttrs = attrsOf(rootMatch?.[1] ?? "");
  const view = (rootAttrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const viewBox = view.length === 4 && view.every(Number.isFinite)
    ? { left: view[0]!, top: view[1]!, right: view[0]! + view[2]!, bottom: view[1]! + view[3]! }
    : undefined;
  const items: Item[] = [];
  const nets = new Map<string, NetDrawing>();
  const looseLabels: Label[] = [];
  const stack: Record<string, string>[] = [];
  const tagPattern = /<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  let current: Item | undefined;
  let currentNet: NetDrawing | undefined;
  const groupTarget = () => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const attrs = stack[index]!;
      if (attrs.class === "part" || attrs.class === "power" || attrs.class === "net") return attrs;
    }
    return undefined;
  };
  const bind = () => {
    const attrs = groupTarget();
    current = undefined;
    currentNet = undefined;
    if (!attrs) return;
    if (attrs.class === "net") {
      const net = attrs["data-net"] ?? "?";
      currentNet = nets.get(net) ?? { net, wires: [], junctions: [] };
      nets.set(net, currentNet);
      return;
    }
    const id = attrs.class === "part" ? `part:${attrs["data-part"] ?? "?"}` : `power:${attrs["data-pin"] ?? "?"}:${attrs["data-net"] ?? "?"}`;
    current = items.find((item) => item.id === id);
    if (!current) {
      current = {
        id,
        kind: attrs.class === "part" ? "part" : "power",
        part: attrs["data-part"],
        pin: attrs["data-pin"],
        net: attrs["data-net"],
        shapes: [],
        outlines: [],
        labels: [],
        leads: [],
        stubs: [],
      };
      items.push(current);
    }
  };
  for (const match of svg.matchAll(tagPattern)) {
    const [, closing, tag, rawAttrs, selfClosing] = match;
    const name = tag!.toLowerCase();
    if (name === "g") {
      if (closing) stack.pop();
      else if (!selfClosing) stack.push(attrsOf(rawAttrs!));
      bind();
      continue;
    }
    if (closing) continue;
    const attrs = attrsOf(rawAttrs!);
    const cls = attrs.class ?? "";
    if (name === "text") {
      const end = svg.indexOf("</text>", match.index);
      const inner = end >= 0 ? svg.slice(match.index + match[0].length, end) : "";
      const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
      if (!text) continue;
      const size = Number((attrs["font-size"] ?? "12").replace("px", ""));
      const anchor = (attrs["text-anchor"] ?? "start") as TextAnchor;
      const bold = attrs["font-weight"] === "bold" || Number(attrs["font-weight"]) >= 600;
      const label = { text, size, box: textBox(num(attrs, "x"), num(attrs, "y"), text, size, anchor, bold), owner: current?.id ?? "" };
      if (current) current.labels.push(label);
      else looseLabels.push(label);
      continue;
    }
    if (currentNet) {
      // Transparent tap targets ("wire-hit") are not drawn; only visible wires count.
      if ((name === "polyline" || name === "line") && !cls.includes("wire-hit")) {
        const points = name === "line"
          ? [{ x: num(attrs, "x1"), y: num(attrs, "y1") }, { x: num(attrs, "x2"), y: num(attrs, "y2") }]
          : pointsOf(attrs);
        for (let index = 1; index < points.length; index += 1) currentNet.wires.push({ a: points[index - 1]!, b: points[index]! });
      } else if (name === "circle") {
        const at = { x: num(attrs, "cx"), y: num(attrs, "cy") };
        const r = num(attrs, "r");
        const entry = { at, box: { left: at.x - r, top: at.y - r, right: at.x + r, bottom: at.y + r } };
        // Every dot drawn on a net reads as a junction, so every one must mark a real branch point.
        currentNet.junctions.push(entry);
      }
      continue;
    }
    if (!current) continue;
    if (name === "line") {
      const seg = { a: { x: num(attrs, "x1"), y: num(attrs, "y1") }, b: { x: num(attrs, "x2"), y: num(attrs, "y2") } };
      current.shapes.push({ type: "seg", seg });
      if (cls.includes("lead") && attrs["data-pin"]) current.leads.push({ pin: attrs["data-pin"], seg });
      if (cls.includes("stub")) current.stubs.push(seg);
    } else if (name === "polyline" || name === "polygon") {
      const points = pointsOf(attrs);
      if (points.length === 0) continue;
      if (name === "polygon") {
        current.shapes.push({ type: "area", box: boxOfPoints(points), rect: false });
      } else {
        for (let index = 1; index < points.length; index += 1) current.shapes.push({ type: "seg", seg: { a: points[index - 1]!, b: points[index]! } });
      }
    } else if (name === "rect") {
      const box = { left: num(attrs, "x"), top: num(attrs, "y"), right: num(attrs, "x") + num(attrs, "width"), bottom: num(attrs, "y") + num(attrs, "height") };
      current.shapes.push({ type: "area", box, rect: true });
      current.outlines.push(...rectEdges(box));
    } else if (name === "circle") {
      const r = num(attrs, "r");
      const box = { left: num(attrs, "cx") - r, top: num(attrs, "cy") - r, right: num(attrs, "cx") + r, bottom: num(attrs, "cy") + r };
      current.shapes.push({ type: "area", box, rect: false });
    }
  }
  return { kind: rootAttrs["data-schematic"], viewBox, items, nets, looseLabels };
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

function describe(p: Pt): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
}

function shapeHitsBox(shape: Shape, box: Box): boolean {
  return shape.type === "seg" ? segIntersectsBox(shape.seg, box) : boxesOverlap(shape.box, box);
}

function withinBox(inner: Box, outer: Box): boolean {
  return inner.left >= outer.left - EPS && inner.top >= outer.top - EPS && inner.right <= outer.right + EPS && inner.bottom <= outer.bottom + EPS;
}

/** True when two symbols' shapes intersect anywhere except a contact at one of the allowed points. */
function shapesCollide(a: Shape, b: Shape, allowedContacts: Pt[]): boolean {
  if (a.type === "area" && b.type === "area") return boxesOverlap(inflate(a.box, -EPS), inflate(b.box, -EPS));
  if (a.type === "seg" && b.type === "area") return segIntersectsBox(a.seg, inflate(b.box, -EPS));
  if (a.type === "area" && b.type === "seg") return segIntersectsBox(b.seg, inflate(a.box, -EPS));
  if (a.type !== "seg" || b.type !== "seg") return false;
  const relation = segRelation(a.seg, b.seg, EPS);
  if (relation.kind === "none") return false;
  if (relation.kind === "touch") return !allowedContacts.some((p) => samePoint(p, relation.at));
  return true;
}

/** Validate a schematic drawing against its circuit. An empty list means the drawing is trustworthy. */
export function checkSchematicSvg(svg: string, circuit: Circuit): SchematicIssue[] {
  const issues: SchematicIssue[] = [];
  const add = (code: string, message: string) => {
    if (issues.length < 60 && !issues.some((issue) => issue.code === code && issue.message === message)) issues.push({ code, message });
  };
  const drawing = parseSchematicSvg(svg);
  if (drawing.kind !== "drawing") add("SCH-NOT-DRAWING", "The SVG is not a schematic drawing.");
  const viewBox = drawing.viewBox;
  if (!viewBox) {
    add("SCH-VIEWBOX", "The SVG has no viewBox.");
    return issues;
  }

  // Pins and their connection points.
  const anchors = new Map<string, { at: Pt; item: Item; lead: Seg }>();
  for (const item of drawing.items) {
    for (const lead of item.leads) {
      if (anchors.has(lead.pin)) add("SCH-PIN-DUPLICATE", `${lead.pin} is drawn twice.`);
      const owner = lead.pin.slice(0, lead.pin.indexOf("."));
      if (item.kind !== "part" || item.part !== owner) add("SCH-PIN-OWNER", `${lead.pin} is drawn outside its part.`);
      anchors.set(lead.pin, { at: lead.seg.b, item, lead: lead.seg });
    }
  }
  const netOfPin = new Map<string, string>();
  for (const net of circuit.nets) for (const ref of net.pins) netOfPin.set(pinKey(ref), net.id);
  for (const part of circuit.parts) if (!drawing.items.some((item) => item.kind === "part" && item.part === part.id)) add("SCH-PART-MISSING", `${part.id} is not drawn.`);
  if (circuit.nets.some((net) => net.pins.some((ref) => ref.part === BOARD_PART)) && !drawing.items.some((item) => item.part === BOARD_PART)) {
    add("SCH-PART-MISSING", "The Arduino is not drawn.");
  }

  // (a) Nets.
  for (const net of circuit.nets) {
    const pins = net.pins.map(pinKey);
    for (const pin of pins) if (!anchors.has(pin)) add("SCH-NET-MISSING-PIN", `${pin} (net ${net.id}) has no drawn pin.`);
    if (net.kind !== "signal") {
      if (drawing.nets.has(net.id)) add("SCH-POWER-WIRED", `Power net ${net.id} is drawn as wires; it must use local symbols.`);
      for (const pin of pins) {
        const anchor = anchors.get(pin);
        const symbol = drawing.items.find((item) => item.kind === "power" && item.pin === pin);
        if (!symbol) {
          add("SCH-POWER-MISSING", `${pin} (net ${net.id}) has no ${net.id} symbol.`);
          continue;
        }
        if (symbol.net !== net.id) add("SCH-POWER-NET", `${pin} carries a ${symbol.net} symbol but is on ${net.id}.`);
        if (symbol.labels.length === 0) add("SCH-POWER-LABEL", `The ${net.id} symbol at ${pin} is unlabelled.`);
        if (anchor && !symbol.stubs.some((stub) => samePoint(stub.a, anchor.at))) add("SCH-POWER-DETACHED", `The ${net.id} symbol at ${pin} does not start at the pin.`);
      }
      continue;
    }
    const drawn = drawing.nets.get(net.id);
    const pinPoints = pins.flatMap((pin) => anchors.get(pin)?.at ?? []);
    if (!drawn || drawn.wires.length === 0) {
      add("SCH-NET-UNWIRED", `Net ${net.id} has no wires.`);
      continue;
    }
    const graph = wireGraph(drawn.wires, pinPoints);
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = key;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(key, root);
      return root;
    };
    for (const key of graph.nodes.keys()) parent.set(key, key);
    for (const [p, q] of graph.edges) parent.set(find(p), find(q));
    const pinNodeKeys = new Set<string>();
    for (const pin of pins) {
      const anchor = anchors.get(pin);
      if (!anchor) continue;
      const hit = [...graph.nodes.entries()].find(([, node]) => samePoint(node.pt, anchor.at));
      if (!hit) {
        add("SCH-NET-PIN-NOT-ON-WIRE", `Net ${net.id} does not end on ${pin} at ${describe(anchor.at)}.`);
        continue;
      }
      pinNodeKeys.add(hit[0]);
    }
    const roots = new Set([...pinNodeKeys].map(find));
    if (roots.size > 1) add("SCH-NET-SPLIT", `Net ${net.id} is drawn as ${roots.size} disconnected pieces.`);
    const componentRoots = new Set([...graph.nodes.keys()].map(find));
    for (const root of componentRoots) if (![...roots].includes(root)) add("SCH-NET-ISLAND", `Net ${net.id} has a wire piece that reaches none of its pins.`);
    for (const [key, node] of graph.nodes) {
      if (node.degree === 1 && !pinNodeKeys.has(key)) add("SCH-NET-DANGLING", `Net ${net.id} has a loose wire end at ${describe(node.pt)}.`);
    }
    const required = junctionPoints(drawn.wires, pinPoints);
    for (const point of required) {
      if (!drawn.junctions.some((dot) => samePoint(dot.at, point, 1))) add("SCH-JUNCTION-MISSING", `Net ${net.id} branches at ${describe(point)} without a junction dot.`);
    }
    for (const dot of drawn.junctions) {
      if (!required.some((point) => samePoint(dot.at, point, 1))) add("SCH-JUNCTION-SPURIOUS", `Net ${net.id} has a junction dot at ${describe(dot.at)} where nothing branches.`);
    }
  }
  for (const netId of drawing.nets.keys()) if (!circuit.nets.some((net) => net.id === netId)) add("SCH-NET-UNKNOWN", `Wires for unknown net ${netId}.`);

  // Wires of different nets; wires through pins and symbols.
  const netEntries = [...drawing.nets.values()];
  for (let i = 0; i < netEntries.length; i += 1) {
    for (let j = i + 1; j < netEntries.length; j += 1) {
      const a = netEntries[i]!;
      const b = netEntries[j]!;
      for (const s of a.wires) {
        for (const t of b.wires) {
          const relation = segRelation(s, t);
          if (relation.kind === "overlap") add("SCH-WIRE-OVERLAP", `Nets ${a.net} and ${b.net} run on top of each other.`);
          else if (relation.kind === "touch") add("SCH-WIRE-TOUCH", `Nets ${a.net} and ${b.net} touch at ${describe(relation.at)}.`);
        }
      }
    }
  }
  for (const [pin, anchor] of anchors) {
    const own = netOfPin.get(pin);
    for (const entry of netEntries) {
      if (entry.net === own) continue;
      if (entry.wires.some((wire) => pointSegDistance(anchor.at, wire) < 2)) add("SCH-WIRE-THROUGH-PIN", `Net ${entry.net} runs through ${pin}.`);
    }
  }
  for (const entry of netEntries) {
    const ownAnchors = [...anchors.entries()].filter(([pin]) => netOfPin.get(pin) === entry.net);
    for (const wire of entry.wires) {
      for (const item of drawing.items) {
        for (const shape of item.shapes) {
          if (shape.type === "area") {
            if (segIntersectsBox(wire, inflate(shape.box, -EPS))) add("SCH-WIRE-THROUGH-SYMBOL", `Net ${entry.net} crosses ${item.id.replace(/^\w+:/, "")}.`);
            continue;
          }
          const relation = segRelation(wire, shape.seg, EPS);
          if (relation.kind === "none") continue;
          const allowed = relation.kind === "touch" && ownAnchors.some(([, anchor]) => anchor.item === item && anchor.lead === shape.seg && samePoint(anchor.at, relation.at));
          if (!allowed) add("SCH-WIRE-THROUGH-SYMBOL", `Net ${entry.net} crosses ${item.id.replace(/^\w+:/, "")}.`);
        }
      }
    }
  }

  // (c) Symbols.
  for (let i = 0; i < drawing.items.length; i += 1) {
    for (let j = i + 1; j < drawing.items.length; j += 1) {
      const a = drawing.items[i]!;
      const b = drawing.items[j]!;
      const contacts: Pt[] = [];
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (x.kind === "power" && x.pin && y.leads.some((lead) => lead.pin === x.pin)) {
          const anchor = anchors.get(x.pin);
          if (anchor) contacts.push(anchor.at);
        }
      }
      if (a.shapes.some((sa) => b.shapes.some((sb) => shapesCollide(sa, sb, contacts)))) add("SCH-SYMBOL-OVERLAP", `${a.id.replace(/^\w+:/, "")} overlaps ${b.id.replace(/^\w+:/, "")}.`);
    }
  }

  // (b) Labels.
  const labels = [...drawing.items.flatMap((item) => item.labels), ...drawing.looseLabels];
  const dots = netEntries.flatMap((entry) => entry.junctions.map((dot) => ({ net: entry.net, box: dot.box })));
  for (const label of labels) {
    if (label.size < MIN_FONT_PX) add("SCH-LABEL-SMALL", `"${label.text}" is smaller than ${MIN_FONT_PX}px.`);
  }
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (boxesOverlap(inflate(labels[i]!.box, LABEL_GAP / 2), inflate(labels[j]!.box, LABEL_GAP / 2))) {
        add("SCH-LABEL-OVERLAP", `Labels "${labels[i]!.text}" and "${labels[j]!.text}" overlap.`);
      }
    }
  }
  for (const label of labels) {
    const box = inflate(label.box, LABEL_GAP);
    for (const entry of netEntries) {
      if (entry.wires.some((wire) => segIntersectsBox(wire, box))) add("SCH-LABEL-ON-WIRE", `Label "${label.text}" sits on a wire of net ${entry.net}.`);
    }
    for (const dot of dots) if (boxesOverlap(dot.box, box)) add("SCH-LABEL-ON-WIRE", `Label "${label.text}" covers a dot of net ${dot.net}.`);
    for (const item of drawing.items) {
      const own = item.id === label.owner;
      const shapes = own ? item.shapes.filter((shape) => !(shape.type === "area" && shape.rect)) : item.shapes;
      const hit = shapes.some((shape) => shapeHitsBox(shape, box)) || (own && item.outlines.some((edge) => segIntersectsBox(edge, box)));
      if (hit) add("SCH-LABEL-ON-SYMBOL", `Label "${label.text}" overlaps ${own ? "its own symbol" : item.id.replace(/^\w+:/, "")}.`);
    }
  }

  // (d) Everything inside the viewBox.
  const outside = (what: string, box: Box) => {
    if (!withinBox(box, viewBox)) add("SCH-OUTSIDE", `${what} is outside the drawing area.`);
  };
  for (const item of drawing.items) {
    for (const shape of item.shapes) outside(item.id.replace(/^\w+:/, ""), shape.type === "area" ? shape.box : boxOfPoints([shape.seg.a, shape.seg.b]));
  }
  for (const label of labels) outside(`Label "${label.text}"`, label.box);
  for (const entry of netEntries) {
    for (const wire of entry.wires) outside(`A wire of net ${entry.net}`, boxOfPoints([wire.a, wire.b]));
    for (const dot of entry.junctions) outside(`A dot of net ${entry.net}`, dot.box);
  }
  return issues;
}

/** Label-only checks for SVGs without symbols (the connection table): readable, non-overlapping, inside the view. */
export function checkTextLayout(svg: string): SchematicIssue[] {
  const drawing = parseSchematicSvg(svg);
  const issues: SchematicIssue[] = [];
  const labels = [...drawing.items.flatMap((item) => item.labels), ...drawing.looseLabels];
  if (!drawing.viewBox) return [{ code: "SCH-VIEWBOX", message: "The SVG has no viewBox." }];
  for (let i = 0; i < labels.length; i += 1) {
    const a = labels[i]!;
    if (!withinBox(a.box, drawing.viewBox)) issues.push({ code: "SCH-OUTSIDE", message: `"${a.text}" is outside the view.` });
    for (let j = i + 1; j < labels.length; j += 1) {
      if (boxesOverlap(a.box, labels[j]!.box)) issues.push({ code: "SCH-LABEL-OVERLAP", message: `"${a.text}" overlaps "${labels[j]!.text}".` });
    }
  }
  return issues;
}
