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

const DEFAULT_WIDTH = 1200;
const BOARD_LEFT = 70;
const BOARD_RIGHT = 1080;
const BOARD_TOP = 112;
const BOARD_BOTTOM = 530;
const TOP_HOLE_Y = 190;
const BOTTOM_HOLE_Y = 370;
const CHANNEL_Y = 310;
const RAIL_Y = { "T-": 58, "T+": 82, "B+": 554, "B-": 578 } as const;

const COLORS: Record<string, string> = {
  red: "#e5484d",
  black: "#202a31",
  yellow: "#f2c94c",
  green: "#2fbf71",
  blue: "#3d8bfd",
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
};

function escapeSvg(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cssColor(name: string): string {
  return COLORS[name] ?? name;
}
function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function boardRows(layout: Layout): number {
  return BREADBOARD_PROFILES[layout.breadboard].rows;
}

function rowX(layout: Layout, row: number): number {
  const rows = boardRows(layout);
  return BOARD_LEFT + ((row - 1) / Math.max(1, rows - 1)) * (BOARD_RIGHT - BOARD_LEFT);
}

function columnY(column: string): number {
  const index = COLUMNS.indexOf(column as (typeof COLUMNS)[number]);
  if (index < 0) return TOP_HOLE_Y;
  return index < 5 ? TOP_HOLE_Y + index * 22 : BOTTOM_HOLE_Y + (index - 5) * 22;
}

function holePoint(layout: Layout, hole: HoleId): Point | undefined {
  const parsed = parseHole(hole);
  if (!parsed) return undefined;
  if (parsed.kind === "terminal") return { x: rowX(layout, parsed.row), y: columnY(parsed.column) };
  const x = rowX(layout, parsed.position);
  return { x, y: RAIL_Y[parsed.rail] };
}

function pinNames(part: Part): string[] {
  return modulePins(part).map((pin) => pin.id);
}

function boardPinPoints(layout: Layout): Map<string, Point> {
  const points = new Map<string, Point>();
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
  const digital = profile.pins.filter((pin) => /^D\d+$/.test(pin.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)));
  const analog = profile.pins.filter((pin) => /^A\d+$/.test(pin.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)));
  const boardLeft = BOARD_LEFT + 80;
  const boardWidth = BOARD_RIGHT - boardLeft - 20;
  digital.forEach((pin, index) => points.set(pin.name, { x: boardLeft + ((index + 0.5) / digital.length) * boardWidth, y: 620 }));
  const lower = ["IOREF", "RESET", "3V3", "5V", "GND", "VIN", ...analog.map((pin) => pin.name), "AREF"];
  const unique = [...new Set(lower.filter((name) => profile.pins.some((pin) => pin.name === name)))];
  unique.forEach((name, index) => points.set(name, { x: boardLeft + ((index + 0.5) / unique.length) * boardWidth, y: 665 }));
  return points;
}

function endpointPoint(layout: Layout, endpoint: Jumper["from"], pins: Map<string, Point>): Point {
  if ("hole" in endpoint) return holePoint(layout, endpoint.hole) ?? { x: BOARD_LEFT, y: TOP_HOLE_Y };
  return pins.get(endpoint.board) ?? { x: BOARD_LEFT, y: 620 };
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

function focusViewBox(input: RenderInput, state: ViewState, pins: Map<string, Point>): ViewBox | undefined {
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
    points.push(endpointPoint(input.layout, jumper.from, pins), endpointPoint(input.layout, jumper.to, pins));
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

function isHighlighted(kind: "part" | "jumper", id: string, highlight: RenderInput["highlight"]): boolean {
  if (!highlight) return false;
  return kind === "part" ? Boolean(highlight.parts?.includes(id)) : Boolean(highlight.jumpers?.includes(id));
}

function renderHoles(layout: Layout, highlight: RenderInput["highlight"]): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const selected = new Set(highlight?.holes ?? []);
  const chunks: string[] = [];
  for (let row = 1; row <= profile.rows; row++) {
    for (const column of COLUMNS) {
      const hole = `${column}${row}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      chunks.push(`<circle id="hole-${escapeSvg(hole)}" cx="${point.x.toFixed(1)}" cy="${point.y}" r="5" class="hole${selected.has(hole) ? " vb-hl" : ""}" aria-label="hole ${escapeSvg(hole)}"><title>${escapeSvg(hole)}</title></circle>`);
    }
  }
  for (const rail of ["T-", "T+", "B+", "B-"] as const) {
    for (const position of profile.railPositions) {
      const hole = `${rail}${position}`;
      const point = holePoint(layout, hole);
      if (!point) continue;
      chunks.push(`<circle id="hole-${escapeSvg(hole)}" cx="${point.x.toFixed(1)}" cy="${point.y}" r="4.3" class="rail-hole${selected.has(hole) ? " vb-hl" : ""}" aria-label="rail hole ${escapeSvg(hole)}"><title>${escapeSvg(hole)}</title></circle>`);
    }
  }
  return chunks.join("");
}

function renderBoard(layout: Layout, pins: Map<string, Point>): string {
  const profile = BOARD_PROFILES[layout.board];
  if (profile.placement === "straddle" && layout.boardAnchor) {
    const start = rowX(layout, layout.boardAnchor.topRow);
    const end = rowX(layout, layout.boardAnchor.topRow + 14);
    const left = Math.min(start, end) - 18;
    const width = Math.abs(end - start) + 36;
    const unique = [...pins.entries()];
    return `<rect x="${left}" y="${CHANNEL_Y - 35}" width="${width}" height="70" rx="8" class="mcu nano"/><text x="${left + width / 2}" y="${CHANNEL_Y + 5}" text-anchor="middle" class="board-title">Arduino Nano</text>${unique.map(([pin, point]) => `<g id="pin-${escapeSvg(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x}" y="${point.y + (point.y < CHANNEL_Y ? -10 : 17)}" text-anchor="middle" class="pin-label">${escapeSvg(pin)}</text></g>`).join("")}`;
  }
  const left = 56;
  const width = 1088;
  return `<rect x="${left}" y="582" width="${width}" height="108" rx="12" class="mcu uno"/><text x="${left + width / 2}" y="603" text-anchor="middle" class="board-title">Arduino Uno R3</text><text x="${left + 12}" y="612" class="header-label">DIGITAL HEADER</text><text x="${left + 12}" y="662" class="header-label">POWER / ANALOG HEADER</text>${[...pins.entries()].map(([pin, point]) => `<g id="pin-${escapeSvg(pin)}"><circle cx="${point.x}" cy="${point.y}" r="6" class="header-pin"/><text x="${point.x}" y="${point.y + (point.y < 620 ? -10 : 17)}" text-anchor="middle" class="pin-label">${escapeSvg(pin)}</text></g>`).join("")}`;
}

function partGeometry(layout: Layout, part: Part, placement: Layout["placements"][number]): { pins: Map<string, Point>; center: Point; angle: number } {
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
  return `<line x1="${a.x}" y1="${a.y}" x2="${k.x}" y2="${k.y}" class="lead"/><circle id="glow-${escapeSvg(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="18" fill="${cssColor(ledColor)}" opacity="${Math.max(0, Math.min(1, state)) * 0.72}" class="led-glow"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="12" fill="${cssColor(ledColor)}" class="led-dome"/><text x="${a.x}" y="${a.y - 10}" class="pin-cue">A +</text><text x="${k.x}" y="${k.y + 17}" class="pin-cue">K −</text>`;
}

function renderResistor(part: Part, geometry: ReturnType<typeof partGeometry>): string {
  const first = geometry.pins.get("1") ?? geometry.center;
  const last = geometry.pins.get("2") ?? geometry.center;
  const bands = resistorBands(Number(part.params.ohms), Number(part.params.tolerancePct ?? 5));
  const bodyWidth = 48;
  const bodyHeight = 20;
  const bandsSvg = bands.map((band, index) => `<rect x="${-bodyWidth / 2 + 9 + index * 9}" y="${-bodyHeight / 2}" width="5" height="${bodyHeight}" fill="${BAND_COLORS[band] ?? "#888"}"/>`).join("");
  return `<line x1="${first.x}" y1="${first.y}" x2="${last.x}" y2="${last.y}" class="lead"/><g transform="translate(${geometry.center.x} ${geometry.center.y})"><rect x="${-bodyWidth / 2}" y="${-bodyHeight / 2}" width="${bodyWidth}" height="${bodyHeight}" rx="5" class="resistor-body"/>${bandsSvg}</g>`;
}

function renderButton(geometry: ReturnType<typeof partGeometry>): string {
  return `<rect x="${geometry.center.x - 28}" y="${CHANNEL_Y - 23}" width="56" height="46" rx="8" class="button-body"/><circle cx="${geometry.center.x}" cy="${CHANNEL_Y}" r="11" class="button-cap"/><text x="${geometry.center.x}" y="${CHANNEL_Y + 4}" text-anchor="middle" class="pin-cue">PRESS</text>`;
}

function renderPhotoresistor(geometry: ReturnType<typeof partGeometry>): string {
  return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="18" class="sensor-body"/><path d="M ${geometry.center.x - 11} ${geometry.center.y + 10} l 8 -22 8 22" class="sensor-mark" fill="none"/>`;
}

function renderPot(geometry: ReturnType<typeof partGeometry>): string {
  return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="21" class="pot-body"/><path d="M ${geometry.center.x - 8} ${geometry.center.y + 9} L ${geometry.center.x + 12} ${geometry.center.y - 11}" class="pot-arrow"/><circle cx="${geometry.center.x + 12}" cy="${geometry.center.y - 11}" r="3" class="pot-arrowhead"/>`;
}

function renderBuzzer(part: Part, geometry: ReturnType<typeof partGeometry>, state: number): string {
  return `<circle id="sound-${escapeSvg(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="22" opacity="${Math.max(0.25, Math.min(1, state || 0.25))}" class="buzzer-body"/><text x="${geometry.center.x}" y="${geometry.center.y + 5}" text-anchor="middle" class="pin-cue">+</text>`;
}

function renderPart(input: RenderInput, part: Part, placement: Layout["placements"][number], state: ViewState): string {
  if (state.visibleParts && !state.visibleParts.has(part.id)) return "";
  const geometry = partGeometry(input.layout, part, placement);
  let body: string;
  if (part.module === "led") body = renderLed(part, geometry, input.partStates?.[part.id] ?? 0);
  else if (part.module === "resistor") body = renderResistor(part, geometry);
  else if (part.module === "button") body = renderButton(geometry);
  else if (part.module === "photoresistor") body = renderPhotoresistor(geometry);
  else if (part.module === "potentiometer") body = renderPot(geometry);
  else if (part.module.startsWith("buzzer")) body = renderBuzzer(part, geometry, input.partStates?.[part.id] ?? 0);
  else body = `<rect x="${geometry.center.x - 24}" y="${geometry.center.y - 14}" width="48" height="28" rx="4" class="generic-body"/>`;
  const newItem = state.newParts.has(part.id);
  const highlighted = isHighlighted("part", part.id, input.highlight);
  const label = state.final || newItem ? partLabel(geometry.center, state.final ? part.id : `${part.id} ${valueLabel(part)}`) : "";
  const pinTitle = pinNames(part).map((pin) => `${pin}:${placement.pins[pin] ?? "?"}`).join(" ");
  return `<g id="part-${escapeSvg(part.id)}" class="${classes("part", highlighted && "vb-hl", newItem && "vb-new", !newItem && !state.final && "vb-old")}" aria-label="${escapeSvg(part.id)} ${escapeSvg(MODULES[part.module].name)}"><title>${escapeSvg(part.id)} — ${escapeSvg(pinTitle)}</title>${body}${label}</g>`;
}

function endpointLabel(endpoint: Jumper["from"]): string {
  return "board" in endpoint ? `Arduino ${endpoint.board}` : endpoint.hole;
}

function renderJumper(input: RenderInput, jumper: Jumper, pins: Map<string, Point>, state: ViewState): string {
  if (state.visibleJumpers && !state.visibleJumpers.has(jumper.id)) return "";
  const from = endpointPoint(input.layout, jumper.from, pins);
  const to = endpointPoint(input.layout, jumper.to, pins);
  const bend = Math.max(25, Math.abs(to.x - from.x) * 0.25);
  const direction = to.x >= from.x ? 1 : -1;
  const path = `M ${from.x} ${from.y} C ${from.x + bend * direction} ${from.y + 18}, ${to.x - bend * direction} ${to.y - 18}, ${to.x} ${to.y}`;
  const newItem = state.newJumpers.has(jumper.id);
  const highlighted = isHighlighted("jumper", jumper.id, input.highlight);
  const label = newItem ? `<rect x="${(from.x + to.x) / 2 - 33}" y="${(from.y + to.y) / 2 - 11}" width="66" height="18" rx="5" class="wire-bg" stroke="${cssColor(String(jumper.color))}"/><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 + 2}" text-anchor="middle" class="wire-label">${escapeSvg(`${jumper.id} ${jumper.net}`)}</text>` : "";
  return `<g id="wire-${escapeSvg(jumper.id)}" class="${classes("wire", highlighted && "vb-hl", newItem && "vb-new", !newItem && !state.final && "vb-old")}" aria-label="${escapeSvg(jumper.id)} ${escapeSvg(jumper.net)}"><title>${escapeSvg(jumper.id)} — ${escapeSvg(jumper.net)}: ${escapeSvg(endpointLabel(jumper.from))} to ${escapeSvg(endpointLabel(jumper.to))}</title><path d="${path}" stroke="${cssColor(String(jumper.color))}" class="wire-path"/>${label}</g>`;
}

function renderRailLabels(layout: Layout): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const end = BOARD_RIGHT;
  const marks: string[] = [`<style>.rail-label{fill:#f2ead8;paint-order:stroke;stroke:#0c1218;stroke-width:2px}.rail-tick{opacity:1;stroke-opacity:.7}</style>`];
  marks.push(`<line x1="${BOARD_LEFT}" y1="${RAIL_Y["T-"]}" x2="${end}" y2="${RAIL_Y["T-"]}" class="rail-minus"/><line x1="${BOARD_LEFT}" y1="${RAIL_Y["T+"]}" x2="${end}" y2="${RAIL_Y["T+"]}" class="rail-plus"/><line x1="${BOARD_LEFT}" y1="${RAIL_Y["B+"]}" x2="${end}" y2="${RAIL_Y["B+"]}" class="rail-plus"/><line x1="${BOARD_LEFT}" y1="${RAIL_Y["B-"]}" x2="${end}" y2="${RAIL_Y["B-"]}" class="rail-minus"/>`);
  marks.push(`<text x="${BOARD_LEFT + 5}" y="${RAIL_Y["T-"] - 6}" class="rail-label">T− GND (−)</text><text x="${BOARD_LEFT + 5}" y="${RAIL_Y["T+"] + 15}" class="rail-label">T+ 5V (+)</text><text x="${BOARD_RIGHT - 2}" y="${RAIL_Y["B+"] + 4}" text-anchor="end" class="rail-label">B+ (+)</text><text x="${BOARD_RIGHT - 2}" y="${RAIL_Y["B-"] + 4}" text-anchor="end" class="rail-label">B− (−)</text>`);
  for (const position of profile.railPositions) {
    const x = holePoint(layout, `T+${position}`)?.x;
    if (x === undefined) continue;
    marks.push(`<line x1="${x}" y1="${RAIL_Y["T-"] - 5}" x2="${x}" y2="${RAIL_Y["T+"] + 5}" class="rail-tick"/><line x1="${x}" y1="${RAIL_Y["B+"] - 5}" x2="${x}" y2="${RAIL_Y["B-"] + 5}" class="rail-tick"/>`);
  }
  return marks.join("");
}

function renderRowLabels(layout: Layout): string {
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

  labels.push(`<text x="${(BOARD_LEFT + BOARD_RIGHT) / 2}" y="${CHANNEL_Y + 5}" text-anchor="middle" class="channel-label">CENTRE CHANNEL</text>`);
  labels.push(`<g id="focus-labels"></g>`);
  return labels.join("");
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

export function renderBreadboardSvg(input: RenderInput): string {
  const width = input.width ?? DEFAULT_WIDTH;
  const state = viewState(input.steps, input.upToStep);
  const pins = boardPinPoints(input.layout);
  const placements = new Map(input.layout.placements.map((placement) => [placement.part, placement]));
  const parts = [...input.circuit.parts].sort((a, b) => a.id.localeCompare(b.id)).map((part) => {
    const placement = placements.get(part.id);
    return placement ? renderPart(input, part, placement, state) : "";
  }).join("");
  const jumpers = [...input.layout.jumpers].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((jumper) => renderJumper(input, jumper, pins, state)).join("");
  const columnLetters = "";
  const focusBox = focusViewBox(input, state, pins);
  const renderHeight = 700;
  const viewBox = focusBox ? `${focusBox.x} ${focusBox.y} ${focusBox.width} ${focusBox.height}` : `0 0 ${width} 700`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${renderHeight}" viewBox="${viewBox}" data-vibread="breadboard" role="img" aria-label="ViBread landscape breadboard assembly"><title>${escapeSvg(input.circuit.title)} breadboard</title><desc>Rows run left to right. Columns a through e are above the horizontal channel; f through j are below it. New step items glow; labels are repeated in text instructions.</desc><style>
svg{font-family:Arial,"DejaVu Sans",sans-serif;background:#0c1218}.board-surface{fill:#d8b06f;stroke:#8c6336;stroke-width:3}.channel{fill:#806741;opacity:.72}.hole{fill:#26313a;stroke:#e6e9ed;stroke-width:1}.rail-hole{fill:#26313a;stroke:#fff;stroke-width:1}.row-label,.column-label,.rail-label,.channel-label{fill:#14212a;font-size:12px;font-weight:700}.column-label{font-size:15px}.column-guide{fill:#f2ead8;font-size:13px;font-weight:700}.rail-label{font-size:12px}.rail-plus{stroke:#e5484d;stroke-width:5}.rail-minus{stroke:#31506d;stroke-width:5}.rail-tick{stroke:#f4f6f8;stroke-width:1;opacity:.7}.lead{stroke:#3b454c;stroke-width:3}.led-dome{stroke:#f8fafc;stroke-width:2}.led-glow{filter:blur(3px)}.resistor-body{fill:#e7c48e;stroke:#653f23;stroke-width:2}.button-body{fill:#44515c;stroke:#eef2f5;stroke-width:2}.button-cap{fill:#bb4d52;stroke:#260d10;stroke-width:2}.sensor-body{fill:#9ca3af;stroke:#111827;stroke-width:2}.sensor-mark{stroke:#17212b;stroke-width:2}.pot-body{fill:#4f6570;stroke:#eef2f5;stroke-width:2}.pot-arrow{stroke:#f1c453;stroke-width:4}.pot-arrowhead{fill:#f1c453}.buzzer-body{fill:#20252a;stroke:#f2c94c;stroke-width:3}.generic-body{fill:#5f7880;stroke:#e5f2f4;stroke-width:2}.mcu{fill:#1b3339;stroke:#90c5bd;stroke-width:3}.board-title{fill:#f3f7f8;font-weight:700;font-size:15px}.header-label{fill:#90c5bd;font-size:11px;font-weight:700}.header-pin{fill:#f2c94c;stroke:#12181d;stroke-width:2}.pin-label{fill:#f3f7f8;font-size:12px;font-weight:700}.pin-cue{fill:#0b141b;font-size:11px;font-weight:700}.part-label{fill:#10191f;font-size:12px;font-weight:700}.label-bg{fill:#f7edcf;stroke:#715c3a;stroke-width:1}.leader{stroke:#32424b;stroke-width:1.5}.wire-path{fill:none;stroke-width:4;stroke-linecap:round;opacity:.9}.wire-bg{fill:#101820}.wire-label{fill:#fff;font-size:11px;font-weight:700}.vb-old{opacity:.48}.part.vb-hl,.wire.vb-hl{filter:drop-shadow(0 0 5px #fff)}.vb-new{filter:drop-shadow(0 0 8px #f7d774)}.hole.vb-hl,.rail-hole.vb-hl{fill:#ffe166;stroke:#111;stroke-width:2}
</style><rect x="0" y="0" width="${width}" height="700" fill="#0c1218"/><rect x="${BOARD_LEFT - 16}" y="${BOARD_TOP - 28}" width="${BOARD_RIGHT - BOARD_LEFT + 32}" height="${BOARD_BOTTOM - BOARD_TOP + 50}" rx="18" class="board-surface"/><rect x="${BOARD_LEFT - 4}" y="${CHANNEL_Y - 24}" width="${BOARD_RIGHT - BOARD_LEFT + 8}" height="48" class="channel"/>${renderRailLabels(input.layout)}${renderRowLabels(input.layout)}${columnLetters}${renderHoles(input.layout, input.highlight)}<g id="board">${renderBoard(input.layout, pins)}</g>${jumpers}${parts}<g class="legend"><rect x="${BOARD_RIGHT - 160}" y="${BOARD_TOP + 5}" width="148" height="42" rx="7" class="label-bg"/><text x="${BOARD_RIGHT - 150}" y="${BOARD_TOP + 22}" class="part-label">Rows left → right</text><text x="${BOARD_RIGHT - 150}" y="${BOARD_TOP + 38}" class="part-label">a–e top · f–j bottom</text></g></svg>`;
  if (!focusBox) return svg;
  const focusedSvg = svg.replace(/class="base-row-label row-label"/g, `class="base-row-label row-label" style="display:none"`).replace(/class="base-column-label column-label"/g, `class="base-column-label column-label" style="display:none"`);
  return focusedSvg.replace(`<g id="focus-labels"></g>`, renderFocusLabels(input.layout, focusBox));
}
