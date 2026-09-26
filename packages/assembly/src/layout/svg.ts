import {
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  COLUMNS,
  MODULES,
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

import { breadboardSideColumns, endpointHoleId, signalColor } from "./allocator.js";

const DEFAULT_WIDTH = 1200;
const BOARD_X = 120;
const BOARD_RIGHT = 900;
const TOP = 102;
const ROW_GAP = 10;
const RAIL_Y = { "T+": 48, "T-": 70, "B+": 0, "B-": 0 } as const;
const PALETTE: Record<string, string> = {
  red: "#e5484d",
  black: "#20232a",
  yellow: "#f2c94c",
  green: "#2fbf71",
  blue: "#3687e8",
  orange: "#f08c2e",
  white: "#f4f6f8",
  purple: "#9b6bdb",
  cyan: "#27c2d1",
  magenta: "#d653a8",
  lime: "#91c73e",
  teal: "#168f8f",
  pink: "#ed6b9a",
  brown: "#986b4f",
  gold: "#bf8b2e",
};
const BAND_COLOR: Record<string, string> = {
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
type VisibleState = { parts?: Set<string>; jumpers?: Set<string>; newParts: Set<string>; newJumpers: Set<string> };

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cls(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

function color(value: string): string {
  return PALETTE[value] ?? value;
}

function boardGeometry(layout: Layout): { rows: number; rowY: (row: number) => number; colX: (column: string) => number; height: number; boardWidth: number } {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const boardWidth = BOARD_RIGHT - BOARD_X;
  const rowY = (row: number): number => TOP + (row - 1) * ROW_GAP;
  const height = rowY(profile.rows) + 150;
  const colX = (column: string): number => {
    const index = COLUMNS.indexOf(column as (typeof COLUMNS)[number]);
    if (index < 5) return BOARD_X + 45 + index * 47;
    return BOARD_X + 45 + index * 47 + 52;
  };
  return { rows: profile.rows, rowY, colX, height, boardWidth };
}

function holePoint(layout: Layout, hole: HoleId): Point | undefined {
  const parsed = parseHole(hole);
  if (!parsed) return undefined;
  const geometry = boardGeometry(layout);
  if (parsed.kind === "terminal") return { x: geometry.colX(parsed.column), y: geometry.rowY(parsed.row) };
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const positionIndex = Math.max(0, profile.railPositions.indexOf(parsed.position));
  const x = BOARD_X + 45 + (positionIndex / Math.max(1, profile.railPositions.length - 1)) * (BOARD_RIGHT - BOARD_X - 90);
  const y = parsed.rail.startsWith("T") ? RAIL_Y[parsed.rail] : geometry.rowY(profile.rows) + 42;
  return { x, y };
}

function boardPinPoints(layout: Layout): Map<string, Point> {
  const points = new Map<string, Point>();
  const profile = BOARD_PROFILES[layout.board];
  const anchor = layout.boardAnchor;
  if (profile.placement === "straddle" && anchor) {
    const header = profile.headers[0]?.pins ?? [];
    header.forEach((pin, index) => {
      const side = index < 15 ? anchor.columns[0] : anchor.columns[1];
      const offset = index < 15 ? index : 29 - index;
      const hole = `${side}${anchor.topRow + offset}`;
      const point = holePoint(layout, hole);
      if (point && !points.has(pin)) points.set(pin, point);
    });
    return points;
  }
  const baseX = BOARD_RIGHT + 92;
  const baseY = 145;
  const pins = profile.headers.flatMap((header) => header.pins);
  const unique = [...new Set(pins)];
  unique.forEach((pin, index) => {
    points.set(pin, { x: baseX + (index % 2) * 90, y: baseY + Math.floor(index / 2) * 22 });
  });
  return points;
}

function endpointPoint(layout: Layout, endpoint: Jumper["from"], pins: Map<string, Point>): Point {
  if ("hole" in endpoint) return holePoint(layout, endpoint.hole) ?? { x: BOARD_X, y: TOP };
  return pins.get(endpoint.board) ?? { x: BOARD_RIGHT + 90, y: TOP };
}

function visibility(steps: StepList | undefined, upToStep: number | undefined): VisibleState {
  if (!steps || upToStep === undefined) return { newParts: new Set(), newJumpers: new Set() };
  const limit = Math.max(0, Math.min(upToStep, steps.steps.length));
  const parts = new Set<string>();
  const jumpers = new Set<string>();
  const newParts = new Set<string>();
  const newJumpers = new Set<string>();
  steps.steps.forEach((step, index) => {
    if (index >= limit) return;
    for (const part of step.adds.parts) {
      parts.add(part);
      if (index === limit - 1) newParts.add(part);
    }
    for (const jumper of step.adds.jumpers) {
      jumpers.add(jumper);
      if (index === limit - 1) newJumpers.add(jumper);
    }
  });
  return { parts, jumpers, newParts, newJumpers };
}

function isHighlighted(kind: "part" | "jumper", id: string, highlight: NonNullable<Parameters<typeof renderBreadboardSvg>[0]>["highlight"]): boolean {
  if (!highlight) return false;
  return kind === "part" ? Boolean(highlight.parts?.includes(id)) : Boolean(highlight.jumpers?.includes(id));
}

function renderHoles(layout: Layout, highlight: NonNullable<Parameters<typeof renderBreadboardSvg>[0]>["highlight"]): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const geometry = boardGeometry(layout);
  const highlighted = new Set(highlight?.holes ?? []);
  const chunks: string[] = [];
  for (let row = 1; row <= profile.rows; row++) {
    chunks.push(`<text x="${BOARD_X - 25}" y="${geometry.rowY(row) + 3}" class="row-label">${row}</text>`);
    for (const column of COLUMNS) {
      const hole = `${column}${row}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      chunks.push(`<circle id="hole-${esc(hole)}" cx="${point.x}" cy="${point.y}" r="4.8" class="hole${highlighted.has(hole) ? " vb-hl" : ""}" aria-label="hole ${esc(hole)}"><title>${esc(hole)}</title></circle>`);
    }
  }
  for (const rail of ["T+", "T-", "B+", "B-"] as const) {
    for (const position of profile.railPositions) {
      const hole = `${rail}${position}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      chunks.push(`<circle id="hole-${esc(hole)}" cx="${point.x}" cy="${point.y}" r="4.2" class="rail-hole${highlighted.has(hole) ? " vb-hl" : ""}" aria-label="rail hole ${esc(hole)}"><title>${esc(hole)}</title></circle>`);
    }
  }
  return chunks.join("");
}

function renderBoard(layout: Layout, pins: Map<string, Point>): string {
  const profile = BOARD_PROFILES[layout.board];
  const geometry = boardGeometry(layout);
  const chunks: string[] = [];
  if (profile.placement === "straddle" && layout.boardAnchor) {
    const top = geometry.rowY(layout.boardAnchor.topRow) - 24;
    const bottom = geometry.rowY(layout.boardAnchor.topRow + 14) + 24;
    const left = geometry.colX(layout.boardAnchor.columns[0]) - 25;
    const right = geometry.colX(layout.boardAnchor.columns[1]) + 25;
    chunks.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="8" class="mcu nano"/><text x="${(left + right) / 2}" y="${top + 18}" text-anchor="middle" class="board-title">Arduino Nano</text>`);
    for (const [pin, point] of pins) {
      const side = point.x < (left + right) / 2 ? "end" : "start";
      chunks.push(`<g id="pin-${esc(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x + (side === "end" ? -9 : 9)}" y="${point.y + 3}" text-anchor="${side}" class="pin-label">${esc(pin)}</text></g>`);
    }
    return chunks.join("");
  }
  const left = BOARD_RIGHT + 32;
  const top = 90;
  const width = 210;
  const height = Math.max(360, Math.ceil((pins.size + 1) / 2) * 22 + 55);
  chunks.push(`<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="12" class="mcu uno"/><text x="${left + width / 2}" y="${top + 24}" text-anchor="middle" class="board-title">Arduino Uno R3</text>`);
  for (const [pin, point] of pins) {
    chunks.push(`<g id="pin-${esc(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x + 10}" y="${point.y + 3}" class="pin-label">${esc(pin)}</text></g>`);
  }
  return chunks.join("");
}

function partPoints(layout: Layout, part: Part, placement: Layout["placements"][number]): { pins: Map<string, Point>; center: Point; angle: number } {
  const pins = new Map<string, Point>();
  for (const pin of modulePinNames(part)) {
    const point = holePoint(layout, placement.pins[pin]);
    if (point) pins.set(pin, point);
  }
  const all = [...pins.values()];
  const center = all.length
    ? { x: all.reduce((sum, point) => sum + point.x, 0) / all.length, y: all.reduce((sum, point) => sum + point.y, 0) / all.length }
    : { x: BOARD_X, y: TOP };
  const first = all[0] ?? center;
  const last = all[all.length - 1] ?? center;
  const angle = Math.atan2(last.y - first.y, last.x - first.x) * (180 / Math.PI);
  return { pins, center, angle };
}

function modulePinNames(part: Part): string[] {
  return modulePins(part).map((pin) => pin.id);
}

function labelAt(point: Point, text: string, dy = -12): string {
  return `<text x="${point.x}" y="${point.y + dy}" text-anchor="middle" class="part-label">${esc(text)}</text>`;
}

function renderLed(part: Part, geometry: ReturnType<typeof partPoints>, state: number): string {
  const a = geometry.pins.get("A") ?? geometry.center;
  const k = geometry.pins.get("K") ?? geometry.center;
  const ledColor = typeof part.params.color === "string" ? part.params.color : "red";
  return `<line x1="${a.x}" y1="${a.y}" x2="${k.x}" y2="${k.y}" class="lead"/><circle id="glow-${esc(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="18" fill="${color(ledColor)}" opacity="${Math.max(0, Math.min(1, state)) * 0.72}" class="led-glow"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="13" fill="${color(ledColor)}" class="led-dome"/><text x="${a.x}" y="${a.y - 8}" class="pin-cue">A +</text><text x="${k.x}" y="${k.y + 16}" class="pin-cue">K −</text>${labelAt(geometry.center, `${part.id} LED`)} `;
}

function renderResistor(part: Part, geometry: ReturnType<typeof partPoints>): string {
  const first = geometry.pins.get("1") ?? geometry.center;
  const last = geometry.pins.get("2") ?? geometry.center;
  const bands = resistorBands(Number(part.params.ohms), Number(part.params.tolerancePct ?? 5));
  const horizontal = Math.abs(last.x - first.x) >= Math.abs(last.y - first.y);
  const rotation = horizontal ? 0 : 90;
  const bodyWidth = 56;
  const bodyHeight = 18;
  const bandMarkup = bands
    .map((band, index) => `<rect x="${-bodyWidth / 2 + 12 + index * 10}" y="${-bodyHeight / 2}" width="6" height="${bodyHeight}" fill="${BAND_COLOR[band] ?? "#888"}"/>`)
    .join("");
  return `<line x1="${first.x}" y1="${first.y}" x2="${last.x}" y2="${last.y}" class="lead"/><g transform="translate(${geometry.center.x} ${geometry.center.y}) rotate(${rotation})"><rect x="${-bodyWidth / 2}" y="${-bodyHeight / 2}" width="${bodyWidth}" height="${bodyHeight}" rx="5" class="resistor-body"/>${bandMarkup}</g>${labelAt(geometry.center, `${part.id} ${formatValue(part)}`)}`;
}

function formatValue(part: Part): string {
  if (part.module === "resistor") {
    const value = Number(part.params.ohms);
    return `${value >= 1000 ? `${value / 1000} k` : value} Ω`;
  }
  return MODULES[part.module].name;
}

function renderButton(part: Part, geometry: ReturnType<typeof partPoints>): string {
  return `<rect x="${geometry.center.x - 30}" y="${geometry.center.y - 18}" width="60" height="36" rx="8" class="button-body"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="10" class="button-cap"/><text x="${geometry.center.x}" y="${geometry.center.y + 4}" text-anchor="middle" class="pin-cue">PRESS</text>${labelAt(geometry.center, `${part.id} button`)}`;
}

function renderPhotoresistor(part: Part, geometry: ReturnType<typeof partPoints>): string {
  return `<line x1="${geometry.center.x - 26}" y1="${geometry.center.y}" x2="${geometry.center.x + 26}" y2="${geometry.center.y}" class="lead"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="18" class="sensor-body"/><path d="M ${geometry.center.x - 10} ${geometry.center.y + 11} l 8 -22 8 22" class="sensor-mark" fill="none"/>${labelAt(geometry.center, `${part.id} light sensor`)}`;
}

function renderPot(part: Part, geometry: ReturnType<typeof partPoints>): string {
  return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="22" class="pot-body"/><path d="M ${geometry.center.x - 8} ${geometry.center.y + 9} L ${geometry.center.x + 13} ${geometry.center.y - 11}" class="pot-arrow"/><circle cx="${geometry.center.x + 13}" cy="${geometry.center.y - 11}" r="3" class="pot-arrowhead"/>${labelAt(geometry.center, `${part.id} knob`)}`;
}

function renderBuzzer(part: Part, geometry: ReturnType<typeof partPoints>): string {
  return `<circle id="sound-${esc(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="24" class="buzzer-body"/><text x="${geometry.center.x}" y="${geometry.center.y + 5}" text-anchor="middle" class="pin-cue">+</text>${labelAt(geometry.center, `${part.id} buzzer`)}`;
}

function renderGeneric(part: Part, geometry: ReturnType<typeof partPoints>): string {
  return `<rect x="${geometry.center.x - 25}" y="${geometry.center.y - 16}" width="50" height="32" rx="4" class="generic-body"/><text x="${geometry.center.x}" y="${geometry.center.y + 4}" text-anchor="middle" class="pin-cue">${esc(part.id)}</text>`;
}

function renderPart(
  layout: Layout,
  part: Part,
  placement: Layout["placements"][number],
  visible: boolean,
  state: number,
  highlight: NonNullable<Parameters<typeof renderBreadboardSvg>[0]>["highlight"],
  isNew: boolean,
): string {
  if (!visible) return "";
  const geometry = partPoints(layout, part, placement);
  let body = "";
  if (part.module === "led") body = renderLed(part, geometry, state);
  else if (part.module === "resistor") body = renderResistor(part, geometry);
  else if (part.module === "button") body = renderButton(part, geometry);
  else if (part.module === "photoresistor") body = renderPhotoresistor(part, geometry);
  else if (part.module === "potentiometer") body = renderPot(part, geometry);
  else if (part.module.startsWith("buzzer")) body = renderBuzzer(part, geometry);
  else body = renderGeneric(part, geometry);
  const pinText = modulePinNames(part)
    .map((pin) => `${pin}:${placement.pins[pin] ?? "?"}`)
    .join(" ");
  const highlighted = isHighlighted("part", part.id, highlight);
  return `<g id="part-${esc(part.id)}" class="${cls("part", highlighted && "vb-hl", isNew && "vb-new")}" aria-label="${esc(part.id)} ${esc(MODULES[part.module].name)}"><title>${esc(part.id)} — ${esc(pinText)}</title>${body}</g>`;
}

function renderJumper(
  layout: Layout,
  jumper: Jumper,
  pins: Map<string, Point>,
  visible: boolean,
  highlight: NonNullable<Parameters<typeof renderBreadboardSvg>[0]>["highlight"],
  isNew: boolean,
): string {
  if (!visible) return "";
  const from = endpointPoint(layout, jumper.from, pins);
  const to = endpointPoint(layout, jumper.to, pins);
  const dx = Math.max(28, Math.abs(to.x - from.x) * 0.35);
  const direction = to.x >= from.x ? 1 : -1;
  const path = `M ${from.x} ${from.y} C ${from.x + dx * direction} ${from.y - 24}, ${to.x - dx * direction} ${to.y + 24}, ${to.x} ${to.y}`;
  const highlighted = isHighlighted("jumper", jumper.id, highlight);
  const stroke = color(String(jumper.color));
  const labelX = (from.x + to.x) / 2;
  const labelY = (from.y + to.y) / 2 - 5;
  const wireText = `${jumper.id} ${jumper.net}`;
  const labelWidth = Math.max(38, wireText.length * 6.4 + 10);
  return `<g id="wire-${esc(jumper.id)}" class="${cls("wire", highlighted && "vb-hl", isNew && "vb-new")}" aria-label="${esc(jumper.id)} ${esc(jumper.net)}"><title>${esc(jumper.id)} — ${esc(jumper.net)}: ${esc(endpointLabel(jumper.from))} to ${esc(endpointLabel(jumper.to))}</title><path d="${path}" stroke="${stroke}" class="wire-path"/><rect x="${labelX - labelWidth / 2}" y="${labelY - 10}" width="${labelWidth}" height="16" rx="5" fill="#101820" stroke="${stroke}"/><text x="${labelX}" y="${labelY + 2}" text-anchor="middle" class="wire-label">${esc(wireText)}</text></g>`;
}

function endpointLabel(endpoint: Jumper["from"]): string {
  return "board" in endpoint ? `Arduino ${endpoint.board}` : endpoint.hole;
}

function renderRails(layout: Layout): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const geometry = boardGeometry(layout);
  const chunks: string[] = [];
  chunks.push(`<line x1="${BOARD_X + 20}" y1="${RAIL_Y["T+"]}" x2="${BOARD_RIGHT - 20}" y2="${RAIL_Y["T+"]}" class="rail-plus"/><line x1="${BOARD_X + 20}" y1="${RAIL_Y["T-"]}" x2="${BOARD_RIGHT - 20}" y2="${RAIL_Y["T-"]}" class="rail-minus"/><text x="${BOARD_X}" y="${RAIL_Y["T+"] + 4}" class="rail-label">T+ 5V (+)</text><text x="${BOARD_X}" y="${RAIL_Y["T-"] + 4}" class="rail-label">T− GND (−)</text>`);
  const bottomY = geometry.rowY(profile.rows) + 42;
  chunks.push(`<line x1="${BOARD_X + 20}" y1="${bottomY}" x2="${BOARD_RIGHT - 20}" y2="${bottomY}" class="rail-plus"/><line x1="${BOARD_X + 20}" y1="${bottomY + 20}" x2="${BOARD_RIGHT - 20}" y2="${bottomY + 20}" class="rail-minus"/><text x="${BOARD_RIGHT + 15}" y="${bottomY + 4}" class="rail-label">B+ (+)</text><text x="${BOARD_RIGHT + 15}" y="${bottomY + 24}" class="rail-label">B− (−)</text>`);
  return chunks.join("");
}

function renderLegend(): string {
  return `<g class="legend"><rect x="20" y="18" width="95" height="54" rx="8" class="legend-box"/><text x="30" y="38" class="legend-text">5 V / T+ = +</text><text x="30" y="57" class="legend-text">GND / T− = −</text></g>`;
}

export function renderBreadboardSvg(input: {
  circuit: Circuit;
  layout: Layout;
  steps?: StepList;
  upToStep?: number;
  highlight?: { holes?: HoleId[]; parts?: string[]; jumpers?: string[] };
  partStates?: Record<string, number>;
  width?: number;
}): string {
  const width = input.width ?? DEFAULT_WIDTH;
  const geometry = boardGeometry(input.layout);
  const visibilityState = visibility(input.steps, input.upToStep);
  const pins = boardPinPoints(input.layout);
  const parts = [...input.circuit.parts].sort((a, b) => a.id.localeCompare(b.id));
  const placements = new Map(input.layout.placements.map((placement) => [placement.part, placement]));
  const partMarkup = parts
    .map((part) => {
      const placement = placements.get(part.id);
      if (!placement) return "";
      const visible = visibilityState.parts === undefined || visibilityState.parts.has(part.id);
      return renderPart(input.layout, part, placement, visible, input.partStates?.[part.id] ?? 0, input.highlight, visibilityState.newParts.has(part.id));
    })
    .join("");
  const jumperMarkup = [...input.layout.jumpers]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((jumper) => renderJumper(input.layout, jumper, pins, visibilityState.jumpers === undefined || visibilityState.jumpers.has(jumper.id), input.highlight, visibilityState.newJumpers.has(jumper.id)))
    .join("");
  const columnLabels = COLUMNS.map((column) => `<text x="${geometry.colX(column)}" y="${TOP - 18}" text-anchor="middle" class="column-label">${column}</text>`).join("");
  const channelX = (geometry.colX("e") + geometry.colX("f")) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${geometry.height}" viewBox="0 0 ${width} ${geometry.height}" data-vibread="breadboard" role="img" aria-label="ViBread breadboard assembly"><title>${esc(input.circuit.title)} breadboard</title><desc>Rows, five-hole contact strips, centre channel, labelled power rails, parts, and jumper endpoints.</desc><style>
svg{font-family:Arial,"DejaVu Sans",sans-serif;background:#0c1218}.board-surface{fill:#d8b06f;stroke:#8c6336;stroke-width:3}.channel{fill:#806741;opacity:.72}.hole{fill:#26313a;stroke:#e6e9ed;stroke-width:1}.rail-hole{fill:#25313b;stroke:#fff;stroke-width:1}.row-label,.column-label,.rail-label{fill:#15202a;font-size:11px;font-weight:700}.column-label{font-size:15px}.part-label{fill:#0d1720;font-size:12px;font-weight:700}.pin-cue{fill:#0b141b;font-size:10px;font-weight:700}.lead{stroke:#3b454c;stroke-width:3}.led-dome{stroke:#f8fafc;stroke-width:2}.led-glow{filter:blur(3px)}.resistor-body{fill:#e7c48e;stroke:#653f23;stroke-width:2}.button-body{fill:#44515c;stroke:#eef2f5;stroke-width:2}.button-cap{fill:#bb4d52;stroke:#260d10;stroke-width:2}.sensor-body{fill:#9ca3af;stroke:#111827;stroke-width:2}.sensor-mark{stroke:#17212b;stroke-width:2}.pot-body{fill:#4f6570;stroke:#eef2f5;stroke-width:2}.pot-arrow{stroke:#f1c453;stroke-width:4}.pot-arrowhead{fill:#f1c453}.buzzer-body{fill:#20252a;stroke:#f2c94c;stroke-width:3}.generic-body{fill:#5f7880;stroke:#e5f2f4;stroke-width:2}.mcu{fill:#1b3339;stroke:#90c5bd;stroke-width:3}.board-title{fill:#f3f7f8;font-weight:700;font-size:15px}.header-pin{fill:#f2c94c;stroke:#12181d;stroke-width:2}.pin-label{fill:#f3f7f8;font-size:10px;font-weight:700}.rail-plus{stroke:#e5484d;stroke-width:5}.rail-minus{stroke:#25313b;stroke-width:5}.wire-path{fill:none;stroke-width:4;stroke-linecap:round;opacity:.9}.wire-label{fill:#fff;font-size:10px;font-weight:700}.legend-box{fill:#f0eadc;stroke:#67563b}.legend-text{fill:#1d2933;font-size:11px;font-weight:700}.part.vb-hl,.wire.vb-hl{filter:drop-shadow(0 0 5px #fff)}.vb-new{filter:drop-shadow(0 0 8px #f7d774)}.hole.vb-hl,.rail-hole.vb-hl{fill:#ffe166;stroke:#111;stroke-width:2}.hole.vb-hl{r:6}.wire.vb-hl .wire-path{stroke-width:7;opacity:1}
</style><rect x="0" y="0" width="${width}" height="${geometry.height}" fill="#0c1218"/><rect x="${BOARD_X}" y="${TOP - 35}" width="${geometry.boardWidth}" height="${geometry.rowY(geometry.rows) - TOP + 115}" rx="18" class="board-surface"/><rect x="${channelX - 19}" y="${TOP - 24}" width="38" height="${geometry.rowY(geometry.rows) - TOP + 77}" class="channel"/><text x="${channelX}" y="${TOP - 5}" text-anchor="middle" class="rail-label">CENTRE CHANNEL</text>${columnLabels}${renderRails(input.layout)}${renderHoles(input.layout, input.highlight)}<g id="board">${renderBoard(input.layout, pins)}</g>${jumperMarkup}${partMarkup}${renderLegend()}</svg>`;
}

export { holePoint, boardPinPoints, signalColor, breadboardSideColumns, endpointHoleId };
