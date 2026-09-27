import {
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  isRailBridge,
  partVariant,
  railBridge,
  COLUMNS,
  MODULES,
  KIT_WIRE_CSS,
  modulePins,
  parseHole,
  resistorBands,
  type Circuit,
  type HoleId,
  type Jumper,
  type Layout,
  type Part,
  type StepList,
} from "@vibread/core";
import { PANEL_CSS, renderPartsPanel, renderRepeatBanner } from "./panel.js";

const DEFAULT_WIDTH = 1200;
const BOARD_LEFT = 70;
const BOARD_RIGHT = 1080;
const BOARD_TOP = 112;
const BOARD_BOTTOM = 530;
const TOP_HOLE_Y = 190;
const BOTTOM_HOLE_Y = 370;
const CHANNEL_Y = 310;
const RAIL_Y = { "T-": 58, "T+": 82, "B+": 554, "B-": 578 } as const;
/** The drawing sits on the app's dark canvas (theme `canvas`); the breadboard itself is a light, real-looking board. */
const CANVAS_FILL = "#1B1D2B";
const BOARD_FILL = "#EEF1F4";

const COLORS: Record<string, string> = {
  ...KIT_WIRE_CSS,
  // LED colours that are not wire colours.
  "warm-white": "#fff1d6",
  pink: "#ed6b9a",
};

const BAND_COLORS: Record<string, string> = {
  black: "#20232a",
  brown: "#8d5524",
  red: "#d84848",
  orange: "#ed7d31",
  yellow: "#e6c229",
  green: "#2f9e44",
  blue: "#3073c4",
  violet: "#7a4db3",
  grey: "#8d99ae",
  white: "#f4f6f8",
  gold: "#c79624",
  silver: "#adb5bd",
};

type Point = { x: number; y: number };
type ViewState = { visibleParts?: Set<string>; visibleJumpers?: Set<string>; newParts: Set<string>; newJumpers: Set<string>; final: boolean };

type RenderInput = {
  circuit: Circuit;
  layout: Layout;
  steps?: StepList;
  upToStep?: number;
  focus?: boolean;
  highlight?: { holes?: HoleId[]; parts?: string[]; jumpers?: string[] };
  partStates?: Record<string, number>;
  width?: number;
  /** Jumper id → colour (kit name or #rrggbb) from `jumperColors`, so the builder's choices show in every picture. */
  wireColors?: Record<string, string>;
};

function escapeSvg(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cssColor(name: string): string {
  const mapped = COLORS[name];
  if (mapped) return mapped;
  if (/^#[0-9a-f]{3,8}$/i.test(name)) return name;
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
}
function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function boardRows(layout: Pick<Layout, "breadboard">): number {
  return BREADBOARD_PROFILES[layout.breadboard].rows;
}

function rowX(layout: Pick<Layout, "breadboard">, row: number): number {
  const rows = boardRows(layout);
  return BOARD_LEFT + ((row - 1) / Math.max(1, rows - 1)) * (BOARD_RIGHT - BOARD_LEFT);
}

function columnY(column: string): number {
  const index = COLUMNS.indexOf(column as (typeof COLUMNS)[number]);
  if (index < 0) return TOP_HOLE_Y;
  return index < 5 ? TOP_HOLE_Y + index * 22 : BOTTOM_HOLE_Y + (index - 5) * 22;
}

function holePoint(layout: Pick<Layout, "breadboard">, hole: HoleId): Point | undefined {
  const parsed = parseHole(hole);
  if (!parsed) return undefined;
  if (parsed.kind === "terminal") return { x: rowX(layout, parsed.row), y: columnY(parsed.column) };
  const x = rowX(layout, parsed.position);
  return { x, y: RAIL_Y[parsed.rail] };
}

function pinNames(part: Part): string[] {
  return modulePins(part).map((pin) => pin.id);
}

/** Header pin positions per board, breadboard, facing and Nano anchor, made once: every wire end and route reads them. */
const PIN_POINTS = new Map<string, ReadonlyMap<string, Point>>();

function boardPinPoints(layout: Pick<Layout, "board" | "boardAnchor" | "breadboard" | "boardOrientation">): ReadonlyMap<string, Point> {
  const key = `${layout.board}|${layout.breadboard}|${layout.boardOrientation ?? ""}|${layout.boardAnchor ? `${layout.boardAnchor.topRow}${layout.boardAnchor.columns.join("")}` : ""}`;
  const known = PIN_POINTS.get(key);
  if (known) return known;
  const points = new Map<string, Point>();
  PIN_POINTS.set(key, points);
  const profile = BOARD_PROFILES[layout.board];
  if (profile.placement === "straddle" && layout.boardAnchor) {
    const header = profile.headers[0]?.pins ?? [];
    header.forEach((pin, index) => {
      const side = index < 15 ? layout.boardAnchor!.columns[0] : layout.boardAnchor!.columns[1];
      const offset = index < 15 ? index : 29 - index;
      const point = holePoint(layout, `${side}${layout.boardAnchor!.topRow + offset}`);
      if (point && !points.has(pin)) points.set(pin, point);
    });
    return points;
  }
  // As on a real Uno lying flat below the breadboard. USB on the left: the digital header is the row nearest the
  // breadboard, reading AREF, D13 … D0 left to right, and the power/analog header IOREF … VIN, A0 … A5 behind it. USB on
  // the right is the same board turned 180°: the power/analog header is nearest (A5 … A0, VIN … IOREF) and the digital
  // header behind it (D0 … D13, AREF).
  const digital = profile.pins.filter((pin) => /^D\d+$/.test(pin.name)).sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));
  const analog = profile.pins.filter((pin) => /^A\d+$/.test(pin.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)));
  const boardLeft = BOARD_LEFT + 80;
  const boardWidth = BOARD_RIGHT - boardLeft - 20;
  const flip = layout.boardOrientation === "usb-right";
  const upper = [...(profile.pins.some((pin) => pin.name === "AREF") ? ["AREF"] : []), ...digital.map((pin) => pin.name)];
  const lower = [...new Set(["IOREF", "RESET", "3V3", "5V", "GND", "VIN", ...analog.map((pin) => pin.name)].filter((name) => profile.pins.some((pin) => pin.name === name)))];
  // The USB end keeps a margin for its marker, so the pins sit a little away from it.
  const place = (names: string[], y: number) => (flip ? [...names].reverse() : names).forEach((name, index) => points.set(name, { x: boardLeft + ((index + 0.5) / names.length) * boardWidth - (flip ? 60 : 0), y }));
  place(flip ? lower : upper, 620);
  place(flip ? upper : lower, 665);
  return points;
}

/** Arduino header pins as drawn, one list per header row, left to right (empty for a Nano on the breadboard). */
export function boardHeaderRows(layout: Pick<Layout, "board" | "boardAnchor" | "breadboard" | "boardOrientation">): string[][] {
  if (BOARD_PROFILES[layout.board].placement === "straddle") return [];
  const rows = new Map<number, { pin: string; x: number }[]>();
  for (const [pin, point] of boardPinPoints(layout)) rows.set(point.y, [...(rows.get(point.y) ?? []), { pin, x: point.x }]);
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, pins]) => pins.sort((a, b) => a.x - b.x).map((entry) => entry.pin));
}

/** Breadboard row drawn straight above an Uno header pin (the allocator puts that pin's circuit there). */
export function headerRow(breadboard: Layout["breadboard"], board: Layout["board"], pin: string, boardOrientation?: Layout["boardOrientation"]): number | undefined {
  if (BOARD_PROFILES[board].placement === "straddle") return undefined;
  const point = boardPinPoints({ board, breadboard, ...(boardOrientation ? { boardOrientation } : {}) }).get(pin);
  if (!point) return undefined;
  const rows = BREADBOARD_PROFILES[breadboard].rows;
  return Math.max(1, Math.min(rows, Math.round(1 + ((point.x - BOARD_LEFT) / (BOARD_RIGHT - BOARD_LEFT)) * (rows - 1))));
}

/** Where a jumper end is drawn: its hole, or its Arduino header pin. */
export function endpointPosition(layout: Pick<Layout, "board" | "boardAnchor" | "breadboard" | "boardOrientation">, endpoint: Jumper["from"]): Point {
  return endpointPoint(layout, endpoint, boardPinPoints(layout));
}

function endpointPoint(layout: Pick<Layout, "board" | "boardAnchor" | "breadboard" | "boardOrientation">, endpoint: Jumper["from"], pins: ReadonlyMap<string, Point>): Point {
  if ("hole" in endpoint) return holePoint(layout, endpoint.hole) ?? { x: BOARD_LEFT, y: TOP_HOLE_Y };
  return pins.get(endpoint.board) ?? { x: BOARD_LEFT, y: 620 };
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function nearPoint(p: Point, q: Point): boolean {
  return Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
}

/** Proper intersection of two segments (touching ends or sharing an end do not count). */
export function segmentsCross(a: [Point, Point], b: [Point, Point]): boolean {
  if (nearPoint(a[0], b[0]) || nearPoint(a[0], b[1]) || nearPoint(a[1], b[0]) || nearPoint(a[1], b[1])) return false;
  const d1 = cross(b[0], b[1], a[0]);
  const d2 = cross(b[0], b[1], a[1]);
  const d3 = cross(a[0], a[1], b[0]);
  const d4 = cross(a[0], a[1], b[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

type RouteLayout = Pick<Layout, "board" | "boardAnchor" | "breadboard" | "boardOrientation" | "placements" | "jumpers">;

/**
 * Edge lanes for the Uno's rail feeds (issue #28), one per rail so the two feeds never cross: the outer rail's wire
 * (− is the rail nearest the board edge, top and bottom) runs outermost, under the Uno and beside the breadboard.
 */
const FEED_LANES = { inner: { side: 26, under: 686 }, outer: { side: 14, under: 695 } } as const;
/** How far a split-rail bridge's staple stands off its rail, toward the board edge. */
const BRIDGE_STANDOFF = 12;

/** An edge-hugging wire: its polyline and where its step label goes (beside the wire, clear of the strips). */
type EdgeRoute = { points: Point[]; label: (labelWidth: number, labelHeight: number) => Point };

/**
 * Drawn route of a wire that hugs the board edge (issue #28), or undefined for an ordinary wire (an S-curve or arc).
 * - An Uno 5 V / GND → rail wire into the rail's end hole: it leaves its header pin through the gap beside it (and
 *   between the pins of the header row below), runs along the bottom edge of the Uno, up the side of the breadboard,
 *   and into the end hole along the rail line, so it never crosses the strips, the parts or the other Uno wires. Only
 *   when no rail hole lies between its hole and the rail's end (it would run over them).
 * - A split-rail bridge: a flat staple on the board-edge side of its rail.
 */
export function jumperRoute(layout: RouteLayout, jumper: Pick<Jumper, "from" | "to">): Point[] | undefined {
  return edgeRoute(layout, jumper, boardPinPoints(layout))?.points;
}

function edgeRoute(layout: RouteLayout, jumper: Pick<Jumper, "from" | "to">, pins: ReadonlyMap<string, Point>): EdgeRoute | undefined {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  if ("hole" in jumper.from && "hole" in jumper.to) {
    const rail = parseHole(jumper.from.hole);
    if (!isRailBridge(profile, jumper) || rail?.kind !== "rail") return undefined;
    const [from, to] = [holePoint(layout, jumper.from.hole)!, holePoint(layout, jumper.to.hole)!];
    const outward = rail.rail.startsWith("T") ? -1 : 1;
    const y = RAIL_Y[rail.rail] + outward * BRIDGE_STANDOFF;
    const outer = rail.rail.endsWith("-");
    return {
      points: [from, { x: from.x, y }, { x: to.x, y }, to],
      // The − rail's label beyond its staple (the board edge); the + rail's on the board side, past the "gap" mark.
      label: (_width, height) => ({ x: (from.x + to.x) / 2, y: outer ? y + outward * (height / 2 + 4) : from.y - outward * (height / 2 + 21) }),
    };
  }
  const boardFirst = "board" in jumper.from;
  const [boardEnd, railEnd] = boardFirst ? [jumper.from, jumper.to] : [jumper.to, jumper.from];
  if (!("board" in boardEnd) || !("hole" in railEnd) || BOARD_PROFILES[layout.board].placement === "straddle") return undefined;
  const rail = parseHole(railEnd.hole);
  const pin = pins.get(boardEnd.board);
  const positions = profile.railPositions;
  if (rail?.kind !== "rail" || !pin || positions.length === 0) return undefined;
  const left = rail.position - positions[0]! <= positions.at(-1)! - rail.position;
  const used = new Set([...layout.placements.flatMap((placement) => Object.values(placement.pins)), ...layout.jumpers.flatMap((entry) => [entry.from, entry.to]).flatMap((end) => ("hole" in end ? [end.hole] : []))]);
  if (positions.some((position) => (left ? position < rail.position : position > rail.position) && used.has(`${rail.rail}${position}`))) return undefined;
  const outer = rail.rail.endsWith("-");
  const lane = outer ? FEED_LANES.outer : FEED_LANES.inner;
  const sideX = left ? lane.side : DEFAULT_WIDTH - lane.side;
  const hole = holePoint(layout, railEnd.hole)!;
  // Leave the pin beside its label (drawn under it) and drop through a gap between the pins of the header row below
  // (or, on the bottom row, of its own row) or past a row's end: the nearest one whose route crosses no other wire.
  // The + feed also keeps clear of the − feed, which picks first and runs in the outer lanes.
  const header = [...pins.values()];
  const below = header.filter((point) => point.y > pin.y + 1).map((point) => point.x);
  const row = (below.length > 0 ? below : header.filter((point) => Math.abs(point.y - pin.y) <= 1).map((point) => point.x)).sort((a, b) => a - b);
  // Several spots across each gap: a wire leaving a neighbouring pin leans across part of it.
  const exits = [row[0]! - 30, ...row.slice(1).flatMap((x, index) => [0.5, 0.35, 0.65, 0.2, 0.8].map((share) => row[index]! + (x - row[index]!) * share)), row.at(-1)! + 30];
  const toward = left ? -1 : 1;
  exits.sort((a, b) => Math.abs(a - pin.x) - Math.abs(b - pin.x) || (b - a) * toward);
  const feed = (entry: Jumper) => ("board" in entry.from && "hole" in entry.to && parseHole(entry.to.hole)?.kind === "rail") || ("board" in entry.to && "hole" in entry.from && parseHole(entry.from.hole)?.kind === "rail");
  const obstacles: Point[][] = layout.jumpers.filter((entry) => !isRailBridge(profile, entry) && !feed(entry)).map((entry) => [endpointPoint(layout, entry.from, pins), endpointPoint(layout, entry.to, pins)]);
  if (!outer) {
    for (const other of layout.jumpers.filter((entry) => feed(entry) && [entry.from, entry.to].some((end) => "hole" in end && end.hole.startsWith(`${rail.rail[0]}-`)))) {
      obstacles.push(edgeRoute(layout, other, pins)?.points ?? [endpointPoint(layout, other.from, pins), endpointPoint(layout, other.to, pins)]);
    }
  }
  const routeFor = (exitX: number) => [pin, { x: exitX, y: pin.y + 10 }, { x: exitX, y: lane.under }, { x: sideX, y: lane.under }, { x: sideX, y: hole.y }, hole];
  // Route segments crossing an obstacle, summed over the obstacles; stops counting once it reaches `limit`.
  const crossings = (points: Point[], limit: number) => {
    let sum = 0;
    for (const line of obstacles) {
      for (let index = 1; index < points.length; index += 1) {
        for (let at = 1; at < line.length; at += 1) {
          if (segmentsCross([points[index - 1]!, points[index]!], [line[at - 1]!, line[at]!])) {
            sum += 1;
            break;
          }
        }
      }
      if (sum >= limit) return sum;
    }
    return sum;
  };
  // The nearest exit whose route crosses nothing, else the first of those crossing the fewest wires.
  let route: Point[] = [];
  let fewest = Infinity;
  for (const exitX of exits) {
    const candidate = routeFor(exitX);
    const count = crossings(candidate, fewest);
    if (count < fewest) {
      fewest = count;
      route = candidate;
      if (count === 0) break;
    }
  }
  return {
    points: boardFirst ? route : route.reverse(),
    // Just inside the side lanes, beside the centre channel (no holes there): the + feed's label above the − feed's.
    label: (width, height) => {
      const x = FEED_LANES.inner.side + 8 + width / 2;
      return { x: left ? x : DEFAULT_WIDTH - x, y: CHANNEL_Y + (outer ? 1 : -1) * (height / 2 + 3) };
    },
  };
}

/** A polyline with its corners rounded (radius up to `radius`, never more than half a segment). */
function roundedPath(points: Point[], radius = 8): string {
  const parts = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const [a, p, b] = [points[index - 1]!, points[index]!, points[index + 1]!];
    const inLength = Math.hypot(p.x - a.x, p.y - a.y) || 1;
    const outLength = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const start = { x: p.x - ((p.x - a.x) / inLength) * r, y: p.y - ((p.y - a.y) / inLength) * r };
    const end = { x: p.x + ((b.x - p.x) / outLength) * r, y: p.y + ((b.y - p.y) / outLength) * r };
    parts.push(`L ${start.x} ${start.y}`, `Q ${p.x} ${p.y} ${end.x} ${end.y}`);
  }
  const last = points.at(-1)!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function viewState(steps: StepList | undefined, upToStep: number | undefined): ViewState {
  if (!steps || upToStep === undefined) return { newParts: new Set(), newJumpers: new Set(), final: true };
  const limit = Math.max(0, Math.min(upToStep, steps.steps.length));
  const visibleParts = new Set<string>();
  const visibleJumpers = new Set<string>();
  const newParts = new Set<string>();
  const newJumpers = new Set<string>();
  steps.steps.forEach((step, index) => {
    if (index >= limit) return;
    for (const part of step.adds.parts) {
      visibleParts.add(part);
      if (index === limit - 1) newParts.add(part);
    }
    for (const jumper of step.adds.jumpers) {
      visibleJumpers.add(jumper);
      if (index === limit - 1) newJumpers.add(jumper);
    }
  });
  return { visibleParts, visibleJumpers, newParts, newJumpers, final: limit >= steps.steps.length };
}
type ViewBox = { x: number; y: number; width: number; height: number };

function focusViewBox(input: RenderInput, state: ViewState, pins: ReadonlyMap<string, Point>): ViewBox | undefined {
  if (!input.focus || !input.steps || input.upToStep === undefined) return undefined;
  const step = input.steps.steps[input.upToStep - 1];
  if (!step || (step.adds.parts.length === 0 && step.adds.jumpers.length === 0)) return undefined;
  const points: Point[] = [];
  const placements = new Map(input.layout.placements.map((placement) => [placement.part, placement]));
  for (const partId of state.newParts) {
    const placement = placements.get(partId);
    if (!placement) continue;
    for (const hole of Object.values(placement.pins)) {
      const point = holePoint(input.layout, hole);
      if (point) points.push(point);
    }
  }
  const jumpers = new Map(input.layout.jumpers.map((jumper) => [jumper.id, jumper]));
  for (const jumperId of state.newJumpers) {
    const jumper = jumpers.get(jumperId);
    if (!jumper) continue;
    // Keep the whole wire (an edge-routed one's lanes too) and its step label in the crop.
    const text = `${jumper.id} ${jumper.net}`;
    const shape = wireShape(input.layout, jumper, pins, Math.max(48, text.length * 7 + 14), 18);
    points.push(...shape.points, shape.label);
  }
  // The first copy of a repeated unit keeps the other copies' ghosts in view, so the ×N reads at a glance.
  if (step.repeat?.role === "template") for (const copy of step.repeat.copies.slice(1)) for (const hole of copy.holes) {
    const point = holePoint(input.layout, hole);
    if (point) points.push(point);
  }
  if (points.length === 0) return undefined;
  const rowPitch = (BOARD_RIGHT - BOARD_LEFT) / Math.max(1, boardRows(input.layout) - 1);
  const marginX = rowPitch * 4;
  const marginY = 44;
  let left = Math.min(...points.map((point) => point.x)) - marginX;
  let right = Math.max(...points.map((point) => point.x)) + marginX;
  let top = Math.min(...points.map((point) => point.y)) - marginY;
  let bottom = Math.max(...points.map((point) => point.y)) + marginY;
  const minimumWidth = (BOARD_RIGHT - BOARD_LEFT) * 0.3;
  let width = Math.max(minimumWidth, right - left);
  let height = Math.max(170, bottom - top);
  const ratio = 4 / 3;
  if (width / height < ratio) width = height * ratio;
  else height = width / ratio;
  width = Math.min(1200, width);
  height = Math.min(700, height);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  left = Math.max(0, Math.min(1200 - width, centerX - width / 2));
  top = Math.max(0, Math.min(700 - height, centerY - height / 2));
  return { x: left, y: top, width, height };
}

function repeatBox(layout: Layout, holes: string[]): { left: number; right: number; top: number; bottom: number } {
  const points = holes.flatMap((hole) => holePoint(layout, hole) ?? []);
  return { left: Math.min(...points.map((p) => p.x)) - 11, right: Math.max(...points.map((p) => p.x)) + 11, top: Math.min(...points.map((p) => p.y)) - 11, bottom: Math.max(...points.map((p) => p.y)) + 11 };
}

/** The "×N" badge on a repeat picture, on the channel: its centre, width and words (undefined off a repeat step). */
function repeatBadge(input: RenderInput): { x: number; width: number; text: string } | undefined {
  const repeat = input.steps && input.upToStep !== undefined ? input.steps.steps[input.upToStep - 1]?.repeat : undefined;
  if (!repeat) return undefined;
  if (repeat.role === "template") {
    // Beside the first copy, at the channel, clear of its wire and the ghosts.
    const first = repeatBox(input.layout, repeat.copies[0]!.holes);
    const text = `×${repeat.count}`;
    const width = text.length * 9 + 18;
    return { x: first.left - width / 2 - 6, width, text };
  }
  const all = repeatBox(input.layout, repeat.copies.flatMap((copy) => copy.holes));
  const text = `×${repeat.count} · ${repeat.columns} column${repeat.columns === 1 ? "" : "s"} apart`;
  const width = text.length * 9 + 18;
  // Right of the row at the channel (left of it when the row reaches the board's right end).
  return { x: all.right + width / 2 + 6 <= BOARD_RIGHT ? all.right + width / 2 + 6 : all.left - width / 2 - 6, width, text };
}

/**
 * Repeated units (issue #25). On the step that builds the first copy: a "×N" badge on it and a dashed ghost where each
 * other copy goes, with the Arduino pin it takes. On the repeat step: the badge over the whole row and each copy's
 * number, so the picture matches the checklist.
 */
function renderRepeatMarks(input: RenderInput): string {
  const step = input.steps && input.upToStep !== undefined ? input.steps.steps[input.upToStep - 1] : undefined;
  const repeat = step?.repeat;
  if (!repeat) return "";
  const copyBoxes = repeat.copies.map((copy) => repeatBox(input.layout, copy.holes));
  const copyLabel = (copy: (typeof repeat.copies)[number], index: number): string => {
    if (copy.boardPins.length === 0) return String(copy.index);
    const full = `${copy.index} · ${copy.boardPins.join(" ")}`;
    const center = (copyBoxes[index]!.left + copyBoxes[index]!.right) / 2;
    const previous = index > 0 ? (copyBoxes[index - 1]!.left + copyBoxes[index - 1]!.right) / 2 : Number.POSITIVE_INFINITY;
    const next = index + 1 < copyBoxes.length ? (copyBoxes[index + 1]!.left + copyBoxes[index + 1]!.right) / 2 : Number.POSITIVE_INFINITY;
    const spacing = Math.min(Math.abs(center - previous), Math.abs(next - center));
    return spacing < full.length * 7 ? String(copy.index) : full;
  };
  const marks: string[] = [];
  if (repeat.role === "template") {
    for (let index = 1; index < repeat.copies.length; index += 1) {
      const copy = repeat.copies[index]!;
      const box = copyBoxes[index]!;
      marks.push(`<g class="repeat-ghost" data-repeat-copy="${copy.index}"><rect x="${box.left}" y="${box.top}" width="${box.right - box.left}" height="${box.bottom - box.top}" rx="8" class="ghost-box"/><text x="${(box.left + box.right) / 2}" y="${box.bottom + 14}" text-anchor="middle" class="ghost-label">${escapeSvg(copyLabel(copy, index))}</text></g>`);
    }
  } else {
    for (let index = 0; index < repeat.copies.length; index += 1) {
      const copy = repeat.copies[index]!;
      const box = copyBoxes[index]!;
      marks.push(`<text x="${(box.left + box.right) / 2}" y="${box.bottom + 14}" text-anchor="middle" class="ghost-label" data-repeat-copy="${copy.index}">${escapeSvg(copyLabel(copy, index))}</text>`);
    }
  }
  const placed = repeatBadge(input)!;
  marks.push(`<g class="repeat-badge"><rect x="${placed.x - placed.width / 2}" y="${CHANNEL_Y - 13}" width="${placed.width}" height="26" rx="13" class="repeat-badge-bg"/><text x="${placed.x}" y="${CHANNEL_Y + 5}" text-anchor="middle" class="repeat-badge-text">${escapeSvg(placed.text)}</text></g>`);
  return `<g id="repeat-marks">${marks.join("")}</g>`;
}

function isHighlighted(kind: "part" | "jumper", id: string, highlight: RenderInput["highlight"]): boolean {
  if (!highlight) return false;
  return kind === "part" ? Boolean(highlight.parts?.includes(id)) : Boolean(highlight.jumpers?.includes(id));
}

function renderHoles(layout: Layout, highlight: RenderInput["highlight"]): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const selected = new Set(highlight?.holes ?? []);
  const highlightedHoles: { hole: string; point: Point }[] = [];
  const chunks: string[] = [];
  for (let row = 1; row <= profile.rows; row++) {
    for (const column of COLUMNS) {
      const hole = `${column}${row}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      const highlighted = selected.has(hole);
      chunks.push(`<circle id="hole-${escapeSvg(hole)}" cx="${point.x.toFixed(1)}" cy="${point.y}" r="5" class="hole${highlighted ? " vb-hl" : ""}" aria-label="hole ${escapeSvg(hole)}"><title>${escapeSvg(hole)}</title></circle>`);
      if (highlighted) {
        highlightedHoles.push({ hole, point });
        chunks.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y}" r="12" class="hole-ring vb-hl" aria-hidden="true"/>`);
      }
    }
  }
  for (const rail of ["T-", "T+", "B+", "B-"] as const) {
    if (!profile.railSides.includes(rail.startsWith("T") ? "top" : "bottom")) continue;
    for (const position of profile.railPositions) {
      const hole = `${rail}${position}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      const highlighted = selected.has(hole);
      chunks.push(`<circle id="hole-${escapeSvg(hole)}" cx="${point.x.toFixed(1)}" cy="${point.y}" r="4.3" class="rail-hole${highlighted ? " vb-hl" : ""}" aria-label="rail hole ${escapeSvg(hole)}"><title>${escapeSvg(hole)}</title></circle>`);
      if (highlighted) {
        highlightedHoles.push({ hole, point });
        chunks.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y}" r="11" class="hole-ring vb-hl" aria-hidden="true"/>`);
      }
    }
  }
  // A long list (a repeat step's twenty holes) is left to the step text and checklist.
  if (highlightedHoles.length > 0 && highlightedHoles.length <= 6) {
    const x = highlightedHoles.reduce((sum, entry) => sum + entry.point.x, 0) / highlightedHoles.length;
    const minY = Math.min(...highlightedHoles.map((entry) => entry.point.y));
    const maxY = Math.max(...highlightedHoles.map((entry) => entry.point.y));
    const labelY = minY < CHANNEL_Y ? Math.max(minY - 14, RAIL_Y["T+"] + 26) : maxY + 22;
    chunks.push(`<text x="${x}" y="${labelY}" text-anchor="middle" class="hole-callout">${highlightedHoles.length === 1 ? "hole" : "holes"} ${highlightedHoles.map((entry) => entry.hole).sort().join(" · ")}</text>`);
  }
  return chunks.join("");
}

function renderBoard(layout: Layout, pins: ReadonlyMap<string, Point>): string {
  const profile = BOARD_PROFILES[layout.board];
  if (profile.placement === "straddle" && layout.boardAnchor) {
    const start = rowX(layout, layout.boardAnchor.topRow);
    const end = rowX(layout, layout.boardAnchor.topRow + 14);
    const left = Math.min(start, end) - 18;
    const width = Math.abs(end - start) + 36;
    const unique = [...pins.entries()];
    return `<rect x="${left}" y="${CHANNEL_Y - 35}" width="${width}" height="70" rx="8" class="mcu nano"/><text x="${left + width / 2}" y="${CHANNEL_Y + 5}" text-anchor="middle" class="board-title">Arduino Nano</text>${unique.map(([pin, point]) => `<g id="pin-${escapeSvg(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x}" y="${point.y + pinLabelOffset(layout, point)}" text-anchor="middle" class="pin-label">${escapeSvg(pin)}</text></g>`).join("")}`;
  }
  const left = 56;
  const width = 1088;
  return `<rect x="${left}" y="582" width="${width}" height="108" rx="12" class="mcu uno"/><text x="${left + width / 2}" y="603" text-anchor="middle" class="board-title">Arduino Uno R3</text>${layout.boardOrientation === "usb-right"
    ? `<text x="${left + width - 12}" y="612" text-anchor="end" class="header-label">POWER / ANALOG HEADER</text><text x="${left + width - 12}" y="662" text-anchor="end" class="header-label">DIGITAL HEADER</text><text x="${left + width - 12}" y="637" text-anchor="end" class="header-label">USB END ▶</text>`
    : `<text x="${left + 12}" y="612" class="header-label">DIGITAL HEADER</text><text x="${left + 12}" y="662" class="header-label">POWER / ANALOG HEADER</text><text x="${left + 12}" y="637" class="header-label">◀ USB END</text>`}${[...pins.entries()].map(([pin, point]) => `<g id="pin-${escapeSvg(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x}" y="${point.y + pinLabelOffset(layout, point)}" text-anchor="middle" class="pin-label">${escapeSvg(pin)}</text></g>`).join("")}`;
}

/** Baseline of an Arduino pin's name from the pin: below it, or above it for a Nano pin on the top half. */
function pinLabelOffset(layout: Pick<Layout, "board">, point: Point): number {
  return BOARD_PROFILES[layout.board].placement === "straddle" && point.y < CHANNEL_Y ? -10 : 17;
}

function partGeometry(layout: Pick<Layout, "breadboard">, part: Part, placement: Pick<Layout["placements"][number], "pins">): { pins: Map<string, Point>; center: Point; angle: number } {
  const pins = new Map<string, Point>();
  for (const pin of pinNames(part)) {
    const point = holePoint(layout, placement.pins[pin]);
    if (point) pins.set(pin, point);
  }
  const values = [...pins.values()];
  const center = values.length
    ? { x: values.reduce((sum, point) => sum + point.x, 0) / values.length, y: values.reduce((sum, point) => sum + point.y, 0) / values.length }
    : { x: BOARD_LEFT, y: TOP_HOLE_Y };
  const first = values[0] ?? center;
  const last = values.at(-1) ?? center;
  return { pins, center, angle: Math.atan2(last.y - first.y, last.x - first.x) * (180 / Math.PI) };
}

export interface DrawingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Drawn extent of a placed part in drawing units: body, leads, pin cues, and its name label (the finished-board
 * picture labels every part by id; the longer "R1 220 Ω" callout only shows on the step that adds the part, on top of
 * everything). The allocator keeps these boxes apart so parts never hide each other.
 */
export function partDrawingBox(breadboard: Layout["breadboard"], part: Part, pins: Record<string, HoleId>): DrawingBox {
  const geometry = partGeometry({ breadboard }, part, { pins });
  const points = [...geometry.pins.values()];
  const { x, y } = geometry.center;
  const boxes: DrawingBox[] = points.map((point) => ({ left: point.x - 5, top: point.y - 5, right: point.x + 5, bottom: point.y + 5 }));
  const around = (rx: number, ry: number) => boxes.push({ left: x - rx, top: y - ry, right: x + rx, bottom: y + ry });
  const pot = part.module === "potentiometer" ? potOutline({ breadboard }, part, geometry) : undefined;
  // A resistor standing across the channel is drawn upright.
  if (part.module === "resistor") (Math.abs(Math.sin((geometry.angle * Math.PI) / 180)) > 0.5 ? around(10, 24) : around(24, 10));
  else if (part.module === "led") {
    around(14, 14);
    for (const point of points) boxes.push({ left: point.x - 2, top: point.y - 20, right: point.x + 24, bottom: point.y + 20 });
  } else if (part.module === "button") around(20, 20);
  else if (part.module === "photoresistor") around(18, 18);
  else if (pot) boxes.push(pot.extent);
  else if (part.module.startsWith("buzzer")) {
    const [p, n] = [geometry.pins.get("P") ?? geometry.center, geometry.pins.get("N") ?? geometry.center];
    const radius = Math.max(14, Math.hypot(p.x - n.x, p.y - n.y) / 2 - 6);
    around(radius, radius);
    boxes.push({ left: p.x - 5, top: p.y - 20, right: p.x + 5, bottom: p.y });
  } else around(24, 14);
  const width = Math.max(42, part.id.length * 7 + 12);
  const label = pot?.label ?? geometry.center;
  boxes.push({ left: label.x - width / 2, top: label.y - 43, right: label.x + width / 2, bottom: label.y - 13 });
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function valueLabel(part: Part): string {
  if (part.module !== "resistor") return MODULES[part.module].name;
  const ohms = Number(part.params.ohms);
  return `${ohms >= 1000 ? `${ohms / 1000} k` : ohms} Ω`;
}

function partLabel(point: Point, text: string): string {
  const width = Math.max(42, text.length * 7 + 12);
  return `<g class="part-callout"><line x1="${point.x}" y1="${point.y - 13}" x2="${point.x}" y2="${point.y - 25}" class="leader"/><rect x="${point.x - width / 2}" y="${point.y - 43}" width="${width}" height="18" rx="5" class="label-bg"/><text x="${point.x}" y="${point.y - 30}" text-anchor="middle" class="part-label">${escapeSvg(text)}</text></g>`;
}

function renderLed(part: Part, geometry: ReturnType<typeof partGeometry>, state: number): string {
  const a = geometry.pins.get("A") ?? geometry.center;
  const k = geometry.pins.get("K") ?? geometry.center;
  const ledColor = typeof part.params.color === "string" ? part.params.color : "red";
  const brightness = Math.max(0, Math.min(1, state));
  const gradientId = `led-gradient-${escapeSvg(part.id)}`;
  const bodyFill = brightness > 0.02 ? cssColor(ledColor) : "#68747c";
  const bodyOpacity = brightness > 0.02 ? 1 : 0.55;
  return `<defs><radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${cssColor(ledColor)}" stop-opacity="0.95"/><stop offset="45%" stop-color="${cssColor(ledColor)}" stop-opacity="0.55"/><stop offset="100%" stop-color="${cssColor(ledColor)}" stop-opacity="0"/></radialGradient></defs>${leadPath(a, k)}<circle id="glow-${escapeSvg(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="42" fill="url(#${gradientId})" opacity="${brightness}" class="led-glow"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="12" fill="${bodyFill}" opacity="${bodyOpacity}" class="led-dome"/><text x="${a.x}" y="${a.y - 10}" class="pin-cue">A +</text><text x="${k.x}" y="${k.y + 17}" class="pin-cue">K −</text>`;
}

/**
 * A straight lead, except where it would run over a hole of a rail it doesn't enter (an LED from row a into the far
 * T− rail passes T+): it steps aside by 8 px while crossing that rail line, so it's plain which rail it goes into.
 */
function leadPath(from: Point, to: Point): string {
  const [top, bottom] = from.y < to.y ? [from, to] : [to, from];
  const crossed = Object.values(RAIL_Y).filter((y) => y > top.y + 2 && y < bottom.y - 2);
  if (crossed.length === 0 || Math.abs(from.x - to.x) > 1) return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="lead"/>`;
  const x = from.x;
  const jog = x + 8;
  const points = [`${top.x} ${top.y}`];
  for (const y of crossed.sort((a, b) => a - b)) points.push(`${x} ${y - 10}`, `${jog} ${y - 4}`, `${jog} ${y + 4}`, `${x} ${y + 10}`);
  points.push(`${bottom.x} ${bottom.y}`);
  return `<path d="M ${points.join(" L ")}" class="lead" fill="none"/>`;
}

function renderResistor(part: Part, geometry: ReturnType<typeof partGeometry>): string {
  const first = geometry.pins.get("1") ?? geometry.center;
  const last = geometry.pins.get("2") ?? geometry.center;
  const bands = resistorBands(Number(part.params.ohms), Number(part.params.tolerancePct ?? 5));
  const bodyWidth = 48;
  const bodyHeight = 20;
  const bandsSvg = bands.map((band, index) => `<rect x="${-bodyWidth / 2 + 9 + index * 9}" y="${-bodyHeight / 2}" width="5" height="${bodyHeight}" fill="${BAND_COLORS[band] ?? "#888"}"/>`).join("");
  return `${leadPath(first, last)}<g transform="translate(${geometry.center.x} ${geometry.center.y})${Math.abs(Math.sin((geometry.angle * Math.PI) / 180)) > 0.5 ? " rotate(90)" : ""}"><rect x="${-bodyWidth / 2}" y="${-bodyHeight / 2}" width="${bodyWidth}" height="${bodyHeight}" rx="5" class="resistor-body"/>${bandsSvg}</g>`;
}

/** Metal lead from the body's edge to the hole it sits in, with a foot on the hole. */
function legTo(center: Point, half: number, pin: Point): string {
  const x = center.x + Math.max(-half, Math.min(half, pin.x - center.x));
  const y = center.y + Math.max(-half, Math.min(half, pin.y - center.y));
  return `<line x1="${x}" y1="${y}" x2="${pin.x}" y2="${pin.y}" class="leg"/><circle cx="${pin.x}" cy="${pin.y}" r="3.5" class="leg-foot"/>`;
}

function renderButton(geometry: ReturnType<typeof partGeometry>): string {
  const { x, y } = geometry.center;
  const half = 20;
  const legs = [...geometry.pins.values()].map((pin) => legTo(geometry.center, half, pin)).join("");
  return `${legs}<rect x="${x - half}" y="${y - half}" width="${half * 2}" height="${half * 2}" rx="5" class="button-body"/><circle cx="${x}" cy="${y}" r="13" class="button-cap"/><text x="${x}" y="${y + 3.5}" text-anchor="middle" class="pin-cue button-text">PRESS</text>`;
}

function renderPhotoresistor(geometry: ReturnType<typeof partGeometry>): string {
  return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="18" class="sensor-body"/><path d="M ${geometry.center.x - 11} ${geometry.center.y + 10} l 8 -22 8 22" class="sensor-mark" fill="none"/>`;
}

/** A pot's body stands off its row by this much (its legs), toward the centre channel, and is this tall. */
const POT_LEG = 10;
const POT_BODY_HEIGHT = 58;

/**
 * Where a potentiometer is drawn (issue #28): a body as wide as the columns it covers (its variant's size: a 10 mm
 * trimmer 4 columns, a 16 mm panel pot 6; 6 for a plain breadboard pot), standing off its row toward the centre
 * channel (over the channel for a pot in row e or f, leaving the rest of its strips clear for wires), legs A/W/B from
 * its edge to their holes, named inside the body's edge, and the knob beyond them. `extent` is all of that plus the
 * leg feet; `label` is where the part's name goes (above its row, or above the body when the body is above the row).
 */
function potOutline(layout: Pick<Layout, "breadboard">, part: Part, geometry: ReturnType<typeof partGeometry>): { body: DrawingBox; extent: DrawingBox; near: number; knob: Point; label: Point; toward: -1 | 1 } {
  const xs = [...geometry.pins.values()].map((point) => point.x);
  const pitch = (BOARD_RIGHT - BOARD_LEFT) / Math.max(1, boardRows(layout) - 1);
  const size = partVariant(part)?.sizeMm;
  const columns = size ? Math.max(3, Math.round(size / 2.54)) : 6;
  const [first, last] = [Math.min(...xs), Math.max(...xs)];
  const mid = (first + last) / 2;
  const half = Math.max((columns * pitch) / 2, (last - first) / 2 + pitch / 2) - 2;
  const row = geometry.center.y;
  const toward = row < CHANNEL_Y ? 1 : -1;
  const near = row + toward * POT_LEG;
  const far = near + toward * POT_BODY_HEIGHT;
  const body = { left: mid - half, right: mid + half, top: Math.min(near, far), bottom: Math.max(near, far) };
  return {
    body,
    extent: { left: body.left, right: body.right, top: Math.min(body.top, row - 5), bottom: Math.max(body.bottom, row + 5) },
    near,
    knob: { x: mid, y: near + toward * 34 },
    label: { x: mid, y: toward > 0 ? row : body.top + 12 },
    toward,
  };
}

function renderPot(layout: Pick<Layout, "breadboard">, part: Part, geometry: ReturnType<typeof partGeometry>): string {
  const { body, near, knob, toward } = potOutline(layout, part, geometry);
  const legs = [...geometry.pins.values()].map((point) => `<line x1="${point.x}" y1="${near}" x2="${point.x}" y2="${point.y}" class="leg"/><circle cx="${point.x}" cy="${point.y}" r="3.5" class="leg-foot"/>`).join("");
  const names = [...geometry.pins].map(([pin, point]) => `<text x="${point.x}" y="${near + (toward > 0 ? 12 : -4)}" text-anchor="middle" class="pot-pin">${escapeSvg(pin)}</text>`).join("");
  return `${legs}<rect x="${body.left}" y="${body.top}" width="${body.right - body.left}" height="${body.bottom - body.top}" rx="6" class="pot-base"/>${names}<circle cx="${knob.x}" cy="${knob.y}" r="21" class="pot-body"/><path d="M ${knob.x - 8} ${knob.y + 9} L ${knob.x + 12} ${knob.y - 11}" class="pot-arrow"/><circle cx="${knob.x + 12}" cy="${knob.y - 11}" r="3" class="pot-arrowhead"/>`;
}

/** Round body centred between its two pins, both pins on their holes; `sound-<ID>` rings show it sounding. */
function renderBuzzer(part: Part, geometry: ReturnType<typeof partGeometry>, state: number): string {
  const { x, y } = geometry.center;
  const p = geometry.pins.get("P") ?? geometry.center;
  const n = geometry.pins.get("N") ?? geometry.center;
  const radius = Math.max(14, Math.hypot(p.x - n.x, p.y - n.y) / 2 - 6);
  const feet = [p, n].map((pin) => `<circle cx="${pin.x}" cy="${pin.y}" r="3.5" class="leg-foot"/>`).join("");
  const rings = `<g id="sound-${escapeSvg(part.id)}" opacity="${Math.max(0, Math.min(1, state))}"><circle cx="${x}" cy="${y}" r="${radius + 7}" class="sound-ring"/><circle cx="${x}" cy="${y}" r="${radius + 14}" class="sound-ring"/></g>`;
  return `${rings}<line x1="${p.x}" y1="${p.y}" x2="${n.x}" y2="${n.y}" class="leg"/><circle cx="${x}" cy="${y}" r="${radius}" class="buzzer-body"/><circle cx="${x}" cy="${y}" r="${Math.round(radius / 3)}" class="buzzer-hole"/>${feet}<text x="${p.x}" y="${p.y - 9}" text-anchor="middle" class="pin-cue">+</text>`;
}

function renderPart(input: RenderInput, part: Part, placement: Layout["placements"][number], state: ViewState): string {
  if (state.visibleParts && !state.visibleParts.has(part.id)) return "";
  const geometry = partGeometry(input.layout, part, placement);
  let body: string;
  if (part.module === "led") body = renderLed(part, geometry, input.partStates?.[part.id] ?? 0);
  else if (part.module === "resistor") body = renderResistor(part, geometry);
  else if (part.module === "button") body = renderButton(geometry);
  else if (part.module === "photoresistor") body = renderPhotoresistor(geometry);
  else if (part.module === "potentiometer") body = renderPot(input.layout, part, geometry);
  else if (part.module.startsWith("buzzer")) body = renderBuzzer(part, geometry, input.partStates?.[part.id] ?? 0);
  else body = `<rect x="${geometry.center.x - 24}" y="${geometry.center.y - 14}" width="48" height="28" rx="4" class="generic-body"/>`;
  const newItem = state.newParts.has(part.id);
  const highlighted = isHighlighted("part", part.id, input.highlight);
  // Many new parts at once (a repeat step): names only, so neighbouring labels don't run into each other.
  const labelAt = part.module === "potentiometer" ? potOutline(input.layout, part, geometry).label : geometry.center;
  const label = state.final || newItem ? partLabel(labelAt, state.final || state.newParts.size > 2 ? part.id : `${part.id} ${valueLabel(part)}`) : "";
  const pinTitle = pinNames(part).map((pin) => `${pin}:${placement.pins[pin] ?? "?"}`).join(" ");
  return `<g id="part-${escapeSvg(part.id)}" class="${classes("part", highlighted && "vb-hl", newItem && "vb-new", !newItem && !state.final && "vb-old")}" aria-label="${escapeSvg(part.id)} ${escapeSvg(MODULES[part.module].name)}"><title>${escapeSvg(part.id)} — ${escapeSvg(pinTitle)}</title>${body}${label}</g>`;
}

function endpointLabel(endpoint: Jumper["from"]): string {
  return "board" in endpoint ? `Arduino ${endpoint.board}` : endpoint.hole;
}

/** Shortest jumper drawn as a plain curve; shorter ones become an arc with a visible bow (issue #19). */
const SHORT_JUMPER = 90;

/**
 * Wire path and the spot for its step label. Long wires keep the S-curve; short ones (a11 → a9) are a quadratic arc
 * bowing away from the holes (upward, or leftward for a vertical hop) by at least 22 px so the wire is never a dot
 * hidden under hole markers. The label sits beside the wire's middle, never on its ends.
 */
function jumperGeometry(from: Point, to: Point, labelWidth: number, labelHeight: number): { path: string; label: Point } {
  // Half the label's extent along a unit normal, so it clears the wire whichever way the normal points.
  const halfExtent = (nx: number, ny: number) => (Math.abs(nx) * labelWidth + Math.abs(ny) * labelHeight) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < SHORT_JUMPER) {
    // Unit normal pointing up (or left when the hop is vertical).
    let nx = length === 0 ? 0 : -dy / length;
    let ny = length === 0 ? -1 : dx / length;
    if (ny > 0 || (ny === 0 && nx > 0)) {
      nx = -nx;
      ny = -ny;
    }
    const bow = Math.max(22, length * 0.45);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const control = { x: mid.x + nx * bow * 2, y: mid.y + ny * bow * 2 };
    const clearance = bow + halfExtent(nx, ny) + 6;
    return { path: `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`, label: { x: mid.x + nx * clearance, y: mid.y + ny * clearance } };
  }
  const bend = Math.max(25, Math.abs(dx) * 0.25);
  const direction = dx >= 0 ? 1 : -1;
  const c1 = { x: from.x + bend * direction, y: from.y + 18 };
  const c2 = { x: to.x - bend * direction, y: to.y - 18 };
  // Midpoint and tangent of the cubic at t = 0.5; the label goes beside it.
  const point = { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 };
  const tangent = { x: to.x + c2.x - c1.x - from.x, y: to.y + c2.y - c1.y - from.y };
  const tangentLength = Math.hypot(tangent.x, tangent.y) || 1;
  let nx = -tangent.y / tangentLength;
  let ny = tangent.x / tangentLength;
  if (nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  const offset = halfExtent(nx, ny) + 12;
  return { path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`, label: { x: point.x + nx * offset, y: point.y + ny * offset } };
}

/**
 * A wire's drawn path, its label spot, and its points: an edge-hugging route (issue #28, `edge`, outlined light so a
 * black wire still shows on the dark canvas), else the curve above.
 */
function wireShape(layout: RouteLayout, jumper: Pick<Jumper, "from" | "to">, pins: ReadonlyMap<string, Point>, labelWidth: number, labelHeight: number): { path: string; label: Point; points: Point[]; edge: boolean } {
  const route = edgeRoute(layout, jumper, pins);
  if (route) return { path: roundedPath(route.points), label: route.label(labelWidth, labelHeight), points: route.points, edge: true };
  const from = endpointPoint(layout, jumper.from, pins);
  const to = endpointPoint(layout, jumper.to, pins);
  return { ...jumperGeometry(from, to, labelWidth, labelHeight), points: [from, to], edge: false };
}

/**
 * "1" and "2" badges on a new wire's two ends, matching "End 1" / "End 2" in the step text. A badge on an Arduino pin
 * sits just off the pin, on the side away from the pin's name, so the name ("D3") still reads.
 */
function endBadges(layout: Pick<Layout, "board">, jumper: Jumper, from: Point, to: Point, stroke: string): string {
  return ([[jumper.from, from, 1], [jumper.to, to, 2]] as const)
    .map(([end, pin, n]) => {
      const point = "board" in end ? { x: pin.x, y: pin.y + (pinLabelOffset(layout, pin) > 0 ? -17 : 17) } : pin;
      return `<g class="wire-end" data-wire-end="${escapeSvg(jumper.id)}:${n}"><circle cx="${point.x}" cy="${point.y}" r="11" class="end-badge" stroke="${stroke}"/><text x="${point.x}" y="${point.y + 4.5}" text-anchor="middle" class="end-badge-text">${n}</text></g>`;
    })
    .join("");
}

/** The wire itself, and (for the step that adds it) its label, drawn in a layer above everything else. */
function renderJumper(input: RenderInput, jumper: Jumper, pins: ReadonlyMap<string, Point>, state: ViewState): { wire: string; label: string } {
  if (state.visibleJumpers && !state.visibleJumpers.has(jumper.id)) return { wire: "", label: "" };
  const from = endpointPoint(input.layout, jumper.from, pins);
  const to = endpointPoint(input.layout, jumper.to, pins);
  const stroke = cssColor(input.wireColors?.[jumper.id] ?? String(jumper.color));
  const text = `${jumper.id} ${jumper.net}`;
  const labelHeight = 18;
  const labelWidth = Math.max(48, text.length * 7 + 14);
  const { path, label: at, edge } = wireShape(input.layout, jumper, pins, labelWidth, labelHeight);
  const newItem = state.newJumpers.has(jumper.id);
  const highlighted = isHighlighted("jumper", jumper.id, input.highlight);
  const label = newItem
    ? `<g class="wire-tag" data-jumper-label="${escapeSvg(jumper.id)}"><rect x="${at.x - labelWidth / 2}" y="${at.y - labelHeight / 2}" width="${labelWidth}" height="${labelHeight}" rx="5" class="wire-bg" stroke="${stroke}"/><text x="${at.x}" y="${at.y + 4}" text-anchor="middle" class="wire-label">${escapeSvg(text)}</text></g>${endBadges(input.layout, jumper, from, to, stroke)}`
    : "";
  const wire = `<g id="wire-${escapeSvg(jumper.id)}" data-jumper="${escapeSvg(jumper.id)}" data-net="${escapeSvg(jumper.net)}" class="${classes("wire", highlighted && "vb-hl", newItem && "vb-new", !newItem && !state.final && "vb-old")}" aria-label="${escapeSvg(jumper.id)} ${escapeSvg(jumper.net)}"><title>${escapeSvg(jumper.id)} — ${escapeSvg(jumper.net)}: ${escapeSvg(endpointLabel(jumper.from))} to ${escapeSvg(endpointLabel(jumper.to))}</title><path d="${path}" class="${classes("wire-casing", edge && "edge-route")}"/><path d="${path}" stroke="${stroke}" class="wire-path"/></g>`;
  return { wire, label };
}

/**
 * The rail lines, names and 5-hole group ticks, only on the edges this breadboard has rails on (none on a mini board).
 * Split rails are drawn as two halves with the gap between them marked, since a bridge wire has to join them.
 */
function renderRailLabels(layout: Layout): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const marks: string[] = [`<style>.rail-label{fill:#2B3440;paint-order:stroke;stroke:${BOARD_FILL};stroke-width:3px}.rail-gap{fill:#C92A2A;font-size:11px;font-weight:700;paint-order:stroke;stroke:${BOARD_FILL};stroke-width:3px}</style>`];
  const bridge = railBridge(profile, profile.railSides.includes("top") ? "T+" : "B+");
  const gap = bridge ? [holePoint(layout, bridge[0])!.x + 7, holePoint(layout, bridge[1])!.x - 7] : undefined;
  const segments: [number, number][] = gap ? [[BOARD_LEFT, gap[0]], [gap[1], BOARD_RIGHT]] : [[BOARD_LEFT, BOARD_RIGHT]];
  const line = (rail: keyof typeof RAIL_Y) => segments.map(([x1, x2]) => `<line x1="${x1}" y1="${RAIL_Y[rail]}" x2="${x2}" y2="${RAIL_Y[rail]}" class="${rail.endsWith("+") ? "rail-plus" : "rail-minus"}"/>`).join("");
  const sides = [
    { side: "top" as const, rails: ["T-", "T+"] as const, labels: `<text x="${BOARD_LEFT + 5}" y="${RAIL_Y["T-"] - 6}" class="rail-label">T− GND (−)</text><text x="${BOARD_LEFT + 5}" y="${RAIL_Y["T+"] + 15}" class="rail-label">T+ 5V (+)</text>` },
    { side: "bottom" as const, rails: ["B+", "B-"] as const, labels: `<text x="${BOARD_RIGHT - 2}" y="${RAIL_Y["B+"] + 4}" text-anchor="end" class="rail-label">B+ (+)</text><text x="${BOARD_RIGHT - 2}" y="${RAIL_Y["B-"] + 4}" text-anchor="end" class="rail-label">B− (−)</text>` },
  ].filter((entry) => profile.railSides.includes(entry.side));
  for (const entry of sides) {
    marks.push(entry.rails.map(line).join(""), entry.labels);
    const [first, second] = entry.rails;
    for (const position of profile.railPositions) {
      const x = holePoint(layout, `${first}${position}`)?.x;
      if (x !== undefined) marks.push(`<line x1="${x}" y1="${Math.min(RAIL_Y[first], RAIL_Y[second]) - 5}" x2="${x}" y2="${Math.max(RAIL_Y[first], RAIL_Y[second]) + 5}" class="rail-tick"/>`);
    }
    if (gap) {
      // Beside the rail pair, on the board side, clear of the bridge wire drawn across the gap.
      const y = first.startsWith("T") ? RAIL_Y["T+"] + 15 : RAIL_Y["B+"] - 8;
      marks.push(`<text x="${(gap[0] + gap[1]) / 2}" y="${y}" text-anchor="middle" class="rail-gap">gap</text>`);
    }
  }
  return marks.join("");
}

function renderRowLabels(layout: Layout, blocked: [number, number][], visible: [number, number]): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const labels: string[] = [];
  for (let row = 1; row <= profile.rows; row++) {
    const x = rowX(layout, row);
    labels.push(`<text x="${x}" y="${TOP_HOLE_Y - 40}" text-anchor="middle" class="base-row-label row-label">${row % 5 === 0 || row === 1 ? row : ""}</text>`);
  }
  for (const column of COLUMNS) {
    labels.push(`<text x="${BOARD_LEFT - 20}" y="${columnY(column) + 5}" text-anchor="end" class="base-column-label column-label">${column}</text>`);
    labels.push(`<text x="${BOARD_RIGHT + 20}" y="${columnY(column) + 5}" class="base-column-label column-label">${column}</text>`);
  }

  const channelX = channelLabelX(layout, blocked, visible);
  if (channelX !== undefined) labels.push(`<text x="${channelX}" y="${CHANNEL_Y + 5}" text-anchor="middle" class="channel-label">CENTRE CHANNEL</text>`);
  labels.push(`<g id="focus-labels"></g>`);
  return labels.join("");
}

/**
 * Where "CENTRE CHANNEL" goes: the middle of the widest stretch of channel no part crosses (a resistor or button over
 * it) and no repeat badge covers, inside the visible picture; undefined when no stretch fits the words.
 */
function channelLabelX(layout: Layout, blocked: [number, number][], visible: [number, number]): number | undefined {
  const labelWidth = 116;
  const spans: [number, number][] = [...blocked];
  for (const placement of layout.placements) {
    const points = Object.values(placement.pins).flatMap((hole) => {
      const parsed = parseHole(hole);
      return parsed?.kind === "terminal" ? [{ top: "abcde".includes(parsed.column), x: holePoint(layout, hole)!.x }] : [];
    });
    if (!points.some((point) => point.top) || points.every((point) => point.top)) continue;
    spans.push([Math.min(...points.map((point) => point.x)) - 16, Math.max(...points.map((point) => point.x)) + 16]);
  }
  const [from, to] = [Math.max(BOARD_LEFT, visible[0]), Math.min(BOARD_RIGHT, visible[1])];
  let best: [number, number] | undefined;
  let cursor = from;
  for (const [left, right] of [...spans, [to, to] as [number, number]].sort((a, b) => a[0] - b[0])) {
    const end = Math.min(left, to);
    if (end - cursor > (best ? best[1] - best[0] : 0)) best = [cursor, end];
    cursor = Math.max(cursor, right);
  }
  if (!best || best[1] - best[0] < labelWidth + 16) return undefined;
  // The board's own middle when it is free (the usual picture), else the middle of the widest free stretch.
  const middle = (BOARD_LEFT + BOARD_RIGHT) / 2;
  if (middle - labelWidth / 2 - 8 >= best[0] && middle + labelWidth / 2 + 8 <= best[1]) return middle;
  return (best[0] + best[1]) / 2;
}
function renderFocusLabels(layout: Layout, box: ViewBox): string {
  const labels: string[] = [];
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  for (let row = 1; row <= profile.rows; row++) {
    const x = rowX(layout, row);
    if (x < box.x || x > box.x + box.width || (row !== 1 && row % 5 !== 0)) continue;
    labels.push(`<text x="${x}" y="${box.y + 16}" text-anchor="middle" class="focus-row-label row-label">${row}</text>`);
  }
  for (const column of COLUMNS) {
    const y = columnY(column);
    if (y < box.y || y > box.y + box.height) continue;
    labels.push(`<text x="${box.x + 8}" y="${y + 4}" class="focus-column-label column-label">${column}</text>`);
    labels.push(`<text x="${box.x + box.width - 8}" y="${y + 4}" text-anchor="end" class="focus-column-label column-label">${column}</text>`);
  }
  return `<g id="focus-labels">${labels.join("")}</g>`;
}

function scopeSvgStyles(svg: string): string {
  const scope = 'svg[data-vibread="breadboard"]';
  return svg.replace(/<style>([\s\S]*?)<\/style>/g, (_match, css: string) => {
    const scoped = css.split("}").map((rule) => {
      const brace = rule.indexOf("{");
      if (brace < 0) return rule;
      const selectors = rule.slice(0, brace).split(",").map((selector) => {
        const trimmed = selector.trim();
        if (!trimmed || trimmed.startsWith("@")) return trimmed;
        return trimmed === "svg" ? scope : `${scope} ${trimmed}`;
      }).join(", ");
      return `${selectors}${rule.slice(brace)}`;
    }).join("}");
    const noFilters = scoped.replace(/filter\s*:\s*[^;}]+;?/gi, "");
    const emphasis = `${scope} .button-text{fill:#fff;stroke:#17212b;stroke-width:2px;paint-order:stroke}${scope} .part.vb-hl .part-label{fill:#fff;stroke:#17212b;stroke-width:2px;paint-order:stroke}${scope} .hole-ring{fill:none;stroke:#E8590C;stroke-width:2.5px}${scope} .hole-callout{fill:#fff;stroke:#101820;stroke-width:2px;paint-order:stroke;font-size:12px;font-weight:700}`;
    return `<style>${noFilters}${emphasis}</style>`;
  });
}

function withWireEndpointHighlights(input: RenderInput): RenderInput {
  const highlightedJumpers = input.highlight?.jumpers ?? [];
  if (highlightedJumpers.length === 0) return input;
  const holes = new Set(input.highlight?.holes ?? []);
  const jumpers = new Map(input.layout.jumpers.map((jumper) => [jumper.id, jumper]));
  for (const id of highlightedJumpers) {
    const jumper = jumpers.get(id);
    if (!jumper) continue;
    if ("hole" in jumper.from) holes.add(jumper.from.hole);
    if ("hole" in jumper.to) holes.add(jumper.to.hole);
  }
  return { ...input, highlight: { ...input.highlight, holes: [...holes] } };
}

export function renderBreadboardSvg(input: RenderInput): string {
  input = withWireEndpointHighlights(input);
  const width = input.width ?? DEFAULT_WIDTH;
  const state = viewState(input.steps, input.upToStep);
  const pins = boardPinPoints(input.layout);
  const placements = new Map(input.layout.placements.map((placement) => [placement.part, placement]));
  const focusBox = focusViewBox(input, state, pins);
  // A focus picture leaves out earlier items that lie wholly outside its crop: they are invisible anyway, and resvg
  // aborts the process (SIGABRT) on a dimmed (opacity) group that is entirely off-canvas.
  const onScreen = (points: Point[]): boolean => {
    if (!focusBox || points.length === 0) return true;
    const margin = 60;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return Math.max(...xs) + margin >= focusBox.x && Math.min(...xs) - margin <= focusBox.x + focusBox.width && Math.max(...ys) + margin >= focusBox.y && Math.min(...ys) - margin <= focusBox.y + focusBox.height;
  };
  const endPoint = (end: Jumper["from"]): Point | undefined => ("hole" in end ? holePoint(input.layout, end.hole) : pins.get(end.board));
  const parts = [...input.circuit.parts].sort((a, b) => a.id.localeCompare(b.id)).map((part) => {
    const placement = placements.get(part.id);
    if (!placement) return "";
    if (!state.newParts.has(part.id) && !onScreen(Object.values(placement.pins).flatMap((hole) => holePoint(input.layout, hole) ?? []))) return "";
    return renderPart(input, part, placement, state);
  }).join("");
  const drawnJumpers = [...input.layout.jumpers]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .filter((jumper) => state.newJumpers.has(jumper.id) || onScreen([endPoint(jumper.from), endPoint(jumper.to)].filter((point): point is Point => point !== undefined)))
    .map((jumper) => ({ jumper, ...renderJumper(input, jumper, pins, state) }));
  // Earlier wires sit under the parts; the wires this step adds are drawn over them so they can't be hidden, and
  // their labels over everything.
  const jumpers = drawnJumpers.filter((entry) => !state.newJumpers.has(entry.jumper.id)).map((entry) => entry.wire).join("");
  const newJumpers = drawnJumpers.filter((entry) => state.newJumpers.has(entry.jumper.id)).map((entry) => entry.wire).join("");
  const jumperLabels = drawnJumpers.map((entry) => entry.label).join("");
  const columnLetters = "";
  const renderHeight = 700;
  const badge = repeatBadge(input);
  const channelBlocked: [number, number][] = badge ? [[badge.x - badge.width / 2 - 6, badge.x + badge.width / 2 + 6]] : [];
  // The "Columns 1–63 / Rows a–e" key, left out of a focus crop that would cut it (the crop has its own labels).
  const legendBox = { x: BOARD_RIGHT - 196, y: BOARD_TOP + 5, width: 184, height: 42 };
  const legend = !focusBox || (legendBox.x >= focusBox.x && legendBox.x + legendBox.width <= focusBox.x + focusBox.width && legendBox.y >= focusBox.y && legendBox.y + legendBox.height <= focusBox.y + focusBox.height)
    ? `<g class="legend"><rect x="${legendBox.x}" y="${legendBox.y}" width="184" height="42" rx="7" class="label-bg"/><text x="${BOARD_RIGHT - 186}" y="${BOARD_TOP + 22}" class="part-label">Columns 1–${BREADBOARD_PROFILES[input.layout.breadboard].rows} left → right</text><text x="${BOARD_RIGHT - 186}" y="${BOARD_TOP + 38}" class="part-label">Rows a–e top · f–j bottom</text></g>`
    : "";
  const viewBox = focusBox ? `${focusBox.x} ${focusBox.y} ${focusBox.width} ${focusBox.height}` : `0 0 ${width} 700`;
  const railSides = BREADBOARD_PROFILES[input.layout.breadboard].railSides;
  const surfaceTop = railSides.includes("top") ? RAIL_Y["T-"] - 22 : 120;
  const surfaceBottom = railSides.includes("bottom") ? RAIL_Y["B-"] + 8 : 495;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${renderHeight}" viewBox="${viewBox}" data-vibread="breadboard" role="img" aria-label="ViBread landscape breadboard assembly"><title>${escapeSvg(input.circuit.title)} breadboard</title><desc>Numbered columns run left to right. Lettered rows a through e are above the centre channel; f through j are below it. New step items are drawn at full strength; earlier ones are dimmed.</desc><style>
svg{font-family:Arial,"DejaVu Sans",sans-serif;background:${CANVAS_FILL}}.ghost-box{fill:#E8590C;fill-opacity:.08;stroke:#E8590C;stroke-width:2;stroke-dasharray:6 4}.ghost-label{fill:#C2410C;font-size:12px;font-weight:800;paint-order:stroke;stroke:${BOARD_FILL};stroke-width:3px}.repeat-badge-bg{fill:#E8590C}.repeat-badge-text{fill:#fff;font-size:15px;font-weight:800}.end-badge{fill:#fff;stroke-width:3}.end-badge-text{fill:#1B1D2B;font-size:13px;font-weight:800}.board-surface{fill:${BOARD_FILL};stroke:#B8C0C9;stroke-width:2}.channel{fill:#D5DAE0}.hole{fill:#39414B;stroke:#AEB6BF;stroke-width:1}.rail-hole{fill:#39414B;stroke:#AEB6BF;stroke-width:1}.row-label,.column-label,.rail-label,.channel-label{fill:#3B4552;font-size:12px;font-weight:700}.column-label{font-size:15px}.column-guide{fill:#3B4552;font-size:13px;font-weight:700}.rail-label{font-size:12px}.rail-plus{stroke:#E03131;stroke-width:3}.rail-minus{stroke:#1C7ED6;stroke-width:3}.rail-tick{stroke:#C3CAD2;stroke-width:1}.lead{stroke:#6C7680;stroke-width:3}.leg{stroke:#8D99AE;stroke-width:3;stroke-linecap:round}.leg-foot{fill:#C9D0D8;stroke:#4A525C;stroke-width:1.5}.led-dome{stroke:#F8FAFC;stroke-width:2}.led-glow{filter:blur(3px)}.resistor-body{fill:#E2C89A;stroke:#7A5A3A;stroke-width:2}.button-body{fill:#2B2F36;stroke:#11151A;stroke-width:2}.button-cap{fill:#C92A2A;stroke:#3B0D0D;stroke-width:2}.sensor-body{fill:#9CA3AF;stroke:#111827;stroke-width:2}.sensor-mark{stroke:#17212B;stroke-width:2}.pot-base{fill:#2F4550;stroke:#9FB3BF;stroke-width:2}.pot-pin{fill:#EEF2F5;font-size:10px;font-weight:700}.pot-body{fill:#4F6570;stroke:#EEF2F5;stroke-width:2}.pot-arrow{stroke:#F1C453;stroke-width:4}.pot-arrowhead{fill:#F1C453}.buzzer-body{fill:#212529;stroke:#0B0D10;stroke-width:2}.buzzer-hole{fill:#495057;stroke:#0B0D10;stroke-width:1}.sound-ring{fill:none;stroke:#E8590C;stroke-width:3;stroke-dasharray:6 5}.generic-body{fill:#5F7880;stroke:#E5F2F4;stroke-width:2}.mcu{fill:#1B3339;stroke:#90C5BD;stroke-width:3}.board-title{fill:#F3F7F8;font-weight:700;font-size:15px}.header-label{fill:#90C5BD;font-size:11px;font-weight:700}.header-pin{fill:#F2C94C;stroke:#12181D;stroke-width:2}.pin-label{fill:#F3F7F8;font-size:12px;font-weight:700}.pin-cue{fill:#1B1D2B;font-size:11px;font-weight:700}.part-label{fill:#1B1D2B;font-size:12px;font-weight:700}.label-bg{fill:#FFFFFF;stroke:#8D99AE;stroke-width:1}.leader{stroke:#5C6773;stroke-width:1.5}.wire-casing{fill:none;stroke:#1B1D2B;stroke-width:6.5;stroke-linecap:round;opacity:.55}.wire-casing.edge-route{stroke:#C9D0D8;opacity:.9}.wire-path{fill:none;stroke-width:4;stroke-linecap:round}.wire-bg{fill:#1B1D2B}.wire-label{fill:#fff;font-size:11px;font-weight:700}.vb-old{opacity:.48}.part.vb-hl,.wire.vb-hl{filter:drop-shadow(0 0 5px #fff)}.vb-new{filter:drop-shadow(0 0 8px #f7d774)}.hole.vb-hl,.rail-hole.vb-hl{fill:#ffe166;stroke:#111;stroke-width:2}
</style><rect x="0" y="0" width="${width}" height="700" fill="${CANVAS_FILL}"/><rect x="${BOARD_LEFT - 36}" y="${surfaceTop}" width="${BOARD_RIGHT - BOARD_LEFT + 72}" height="${surfaceBottom - surfaceTop}" rx="14" class="board-surface"/><rect x="${BOARD_LEFT - 4}" y="${CHANNEL_Y - 24}" width="${BOARD_RIGHT - BOARD_LEFT + 8}" height="48" class="channel"/>${renderRailLabels(input.layout)}${renderRowLabels(input.layout, channelBlocked, focusBox ? [focusBox.x, focusBox.x + focusBox.width] : [0, width])}${columnLetters}${renderHoles(input.layout, input.highlight)}<g id="board">${renderBoard(input.layout, pins)}</g>${jumpers}${parts}${newJumpers}${renderRepeatMarks(input)}${jumperLabels}${legend}</svg>`;
  const scopedSvg = scopeSvgStyles(svg);
  const backgroundSvg = focusBox ? scopedSvg.replace(`<rect x="0" y="0" width="${width}" height="700" fill="${CANVAS_FILL}"/>`, `<rect x="0" y="0" width="${width}" height="700" fill="${BOARD_FILL}"/>`) : scopedSvg;
  const boardSvg = focusBox
    ? backgroundSvg.replace(/class="base-row-label row-label"/g, `class="base-row-label row-label" style="display:none"`).replace(/class="base-column-label column-label"/g, `class="base-column-label column-label" style="display:none"`).replace(`<g id="focus-labels"></g>`, renderFocusLabels(input.layout, focusBox))
    : backgroundSvg;
  return withPartsPanel(input, state, boardSvg, focusBox ?? { x: 0, y: 0, width, height: 700 }, width, focusBox !== undefined);
}

/** A focus picture is read on a phone: its panel is 1.5× taller, so a lone part is drawn 1.5× larger (1200 × 1470). */
const FOCUS_PANEL_ZOOM = 1.5;

/**
 * A step picture with new pieces gets the "parts for this step" panel under the board or crop (issue #22), with dashed
 * arrows from each drawn leg to its hole. Below rather than beside, so the board keeps its width in the narrow desktop
 * steps panel and on a portrait phone. Pictures without new pieces (final board, Try it, bench) are unchanged.
 */
function withPartsPanel(input: RenderInput, state: ViewState, boardSvg: string, view: ViewBox, width: number, focused: boolean): string {
  if (!input.steps || input.upToStep === undefined || (state.newParts.size === 0 && state.newJumpers.size === 0)) return boardSvg;
  const current = input.steps.steps[input.upToStep - 1];
  // The repeat step: a one-line banner under the whole board and under a focus crop alike. The copies are drawn on the
  // board, the step text lists them, and both screens have the tickable checklist.
  const repeat = current?.repeat?.role === "repeat" ? current.repeat : undefined;
  const panel = repeat ? renderRepeatBanner(repeat) : renderPartsPanel({
    circuit: input.circuit,
    layout: input.layout,
    parts: [...state.newParts],
    jumpers: [...state.newJumpers],
    wireCss: (jumper) => cssColor(input.wireColors?.[jumper.id] ?? String(jumper.color)),
    css: cssColor,
    bandCss: (name) => BAND_COLORS[name] ?? cssColor(name),
  }, focused ? FOCUS_PANEL_ZOOM : 1);
  if (!panel) return boardSvg;
  // Root coordinates stay the board's own (the crop is the root viewBox, as without a panel); the panel, drawn in
  // 1200-unit picture coordinates, is scaled into the strip below the crop. Scaling the board instead (a transformed
  // group or nested <svg>) makes resvg panic on some boards.
  const unit = view.width / panel.width;
  const panelTop = view.y + view.height;
  const panelHeight = panel.height * unit;
  const totalHeight = Math.round((view.height + panelHeight) * (width / view.width));
  const open = boardSvg.match(/^<svg\b[^>]*>/)![0];
  const inner = boardSvg.slice(open.length, boardSvg.lastIndexOf("</svg>"));
  // Arrows only for one or two drawn parts: from a crowded panel they would criss-cross the board.
  const arrows = (panel.anchors.length > 0 && state.newParts.size <= 2 && state.newParts.size + state.newJumpers.size <= 2 ? panel.anchors : []).map((anchor) => {
    const hole = holePoint(input.layout, anchor.hole);
    if (!hole) return "";
    const lift = 8 * unit;
    const head = 7 * unit;
    // Arrows leave the panel's top edge straight above the leg, so they never cross the panel's own drawing.
    const start = { x: view.x + anchor.point.x * unit, y: panelTop + 10 * unit };
    const middle = (start.y + hole.y) / 2;
    return `<path d="M ${start.x} ${start.y} C ${start.x} ${middle}, ${hole.x} ${middle}, ${hole.x} ${hole.y + lift}" class="panel-arrow" style="stroke-width:${3 * unit}px;stroke-dasharray:${10 * unit} ${7 * unit}" data-arrow-hole="${escapeSvg(anchor.hole)}"/><path d="M ${hole.x - head} ${hole.y + lift + 12 * unit} L ${hole.x} ${hole.y + lift - unit} L ${hole.x + head} ${hole.y + lift + 12 * unit} Z" class="panel-arrow-head"/>`;
  }).join("");
  const rootOpen = open
    .replace(/ height="[^"]*"/, ` height="${totalHeight}"`)
    .replace(/ viewBox="[^"]*"/, ` viewBox="${view.x} ${view.y} ${view.width} ${view.height + panelHeight}"`);
  const panelStyle = scopeSvgStyles(`<style>${PANEL_CSS}</style>`);
  return `${rootOpen}${panelStyle}${inner}<g id="parts-panel" transform="translate(${view.x} ${panelTop}) scale(${unit})"><rect x="0" y="0" width="${panel.width}" height="${panel.height}" fill="${CANVAS_FILL}"/>${panel.svg}</g><g id="panel-arrows">${arrows}</g></svg>`;
}
