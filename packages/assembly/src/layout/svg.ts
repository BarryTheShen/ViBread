import {
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
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

function boardPinPoints(layout: Pick<Layout, "board" | "boardAnchor" | "breadboard">): Map<string, Point> {
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

/** Breadboard row drawn straight above an Uno header pin (the allocator puts that pin's circuit there). */
export function headerRow(breadboard: Layout["breadboard"], board: Layout["board"], pin: string): number | undefined {
  if (BOARD_PROFILES[board].placement === "straddle") return undefined;
  const point = boardPinPoints({ board, breadboard }).get(pin);
  if (!point) return undefined;
  const rows = BREADBOARD_PROFILES[breadboard].rows;
  return Math.max(1, Math.min(rows, Math.round(1 + ((point.x - BOARD_LEFT) / (BOARD_RIGHT - BOARD_LEFT)) * (rows - 1))));
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
  if (highlightedHoles.length > 0) {
    const x = highlightedHoles.reduce((sum, entry) => sum + entry.point.x, 0) / highlightedHoles.length;
    const minY = Math.min(...highlightedHoles.map((entry) => entry.point.y));
    const maxY = Math.max(...highlightedHoles.map((entry) => entry.point.y));
    const labelY = minY < CHANNEL_Y ? minY - 14 : maxY + 22;
    chunks.push(`<text x="${x}" y="${labelY}" text-anchor="middle" class="hole-callout">holes ${highlightedHoles.map((entry) => entry.hole).sort().join(" · ")}</text>`);
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
  if (part.module === "resistor") around(24, 10);
  else if (part.module === "led") {
    around(14, 14);
    for (const point of points) boxes.push({ left: point.x - 2, top: point.y - 20, right: point.x + 24, bottom: point.y + 20 });
  } else if (part.module === "button") around(20, 20);
  else if (part.module === "photoresistor") around(18, 18);
  else if (part.module === "potentiometer") around(21, 21);
  else if (part.module.startsWith("buzzer")) {
    const [p, n] = [geometry.pins.get("P") ?? geometry.center, geometry.pins.get("N") ?? geometry.center];
    const radius = Math.max(14, Math.hypot(p.x - n.x, p.y - n.y) / 2 - 6);
    around(radius, radius);
    boxes.push({ left: p.x - 5, top: p.y - 20, right: p.x + 5, bottom: p.y });
  } else around(24, 14);
  const width = Math.max(42, part.id.length * 7 + 12);
  boxes.push({ left: x - width / 2, top: y - 43, right: x + width / 2, bottom: y - 13 });
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
  return `<defs><radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${cssColor(ledColor)}" stop-opacity="0.95"/><stop offset="45%" stop-color="${cssColor(ledColor)}" stop-opacity="0.55"/><stop offset="100%" stop-color="${cssColor(ledColor)}" stop-opacity="0"/></radialGradient></defs><line x1="${a.x}" y1="${a.y}" x2="${k.x}" y2="${k.y}" class="lead"/><circle id="glow-${escapeSvg(part.id)}" cx="${geometry.center.x}" cy="${geometry.center.y}" r="42" fill="url(#${gradientId})" opacity="${brightness}" class="led-glow"/><circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="12" fill="${bodyFill}" opacity="${bodyOpacity}" class="led-dome"/><text x="${a.x}" y="${a.y - 10}" class="pin-cue">A +</text><text x="${k.x}" y="${k.y + 17}" class="pin-cue">K −</text>`;
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

function renderPot(geometry: ReturnType<typeof partGeometry>): string {
  return `<circle cx="${geometry.center.x}" cy="${geometry.center.y}" r="21" class="pot-body"/><path d="M ${geometry.center.x - 8} ${geometry.center.y + 9} L ${geometry.center.x + 12} ${geometry.center.y - 11}" class="pot-arrow"/><circle cx="${geometry.center.x + 12}" cy="${geometry.center.y - 11}" r="3" class="pot-arrowhead"/>`;
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
  const stroke = cssColor(input.wireColors?.[jumper.id] ?? String(jumper.color));
  const direction = to.x >= from.x ? 1 : -1;
  const path = `M ${from.x} ${from.y} C ${from.x + bend * direction} ${from.y + 18}, ${to.x - bend * direction} ${to.y - 18}, ${to.x} ${to.y}`;
  const newItem = state.newJumpers.has(jumper.id);
  const highlighted = isHighlighted("jumper", jumper.id, input.highlight);
  const label = newItem ? `<rect x="${(from.x + to.x) / 2 - 33}" y="${(from.y + to.y) / 2 - 11}" width="66" height="18" rx="5" class="wire-bg" stroke="${stroke}"/><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 + 2}" text-anchor="middle" class="wire-label">${escapeSvg(`${jumper.id} ${jumper.net}`)}</text>` : "";
  return `<g id="wire-${escapeSvg(jumper.id)}" data-jumper="${escapeSvg(jumper.id)}" data-net="${escapeSvg(jumper.net)}" class="${classes("wire", highlighted && "vb-hl", newItem && "vb-new", !newItem && !state.final && "vb-old")}" aria-label="${escapeSvg(jumper.id)} ${escapeSvg(jumper.net)}"><title>${escapeSvg(jumper.id)} — ${escapeSvg(jumper.net)}: ${escapeSvg(endpointLabel(jumper.from))} to ${escapeSvg(endpointLabel(jumper.to))}</title><path d="${path}" class="wire-casing"/><path d="${path}" stroke="${stroke}" class="wire-path"/>${label}</g>`;
}

function renderRailLabels(layout: Layout): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const end = BOARD_RIGHT;
  const marks: string[] = [`<style>.rail-label{fill:#2B3440;paint-order:stroke;stroke:${BOARD_FILL};stroke-width:3px}</style>`];
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
svg{font-family:Arial,"DejaVu Sans",sans-serif;background:${CANVAS_FILL}}.board-surface{fill:${BOARD_FILL};stroke:#B8C0C9;stroke-width:2}.channel{fill:#D5DAE0}.hole{fill:#39414B;stroke:#AEB6BF;stroke-width:1}.rail-hole{fill:#39414B;stroke:#AEB6BF;stroke-width:1}.row-label,.column-label,.rail-label,.channel-label{fill:#3B4552;font-size:12px;font-weight:700}.column-label{font-size:15px}.column-guide{fill:#3B4552;font-size:13px;font-weight:700}.rail-label{font-size:12px}.rail-plus{stroke:#E03131;stroke-width:3}.rail-minus{stroke:#1C7ED6;stroke-width:3}.rail-tick{stroke:#C3CAD2;stroke-width:1}.lead{stroke:#6C7680;stroke-width:3}.leg{stroke:#8D99AE;stroke-width:3;stroke-linecap:round}.leg-foot{fill:#C9D0D8;stroke:#4A525C;stroke-width:1.5}.led-dome{stroke:#F8FAFC;stroke-width:2}.led-glow{filter:blur(3px)}.resistor-body{fill:#E2C89A;stroke:#7A5A3A;stroke-width:2}.button-body{fill:#2B2F36;stroke:#11151A;stroke-width:2}.button-cap{fill:#C92A2A;stroke:#3B0D0D;stroke-width:2}.sensor-body{fill:#9CA3AF;stroke:#111827;stroke-width:2}.sensor-mark{stroke:#17212B;stroke-width:2}.pot-body{fill:#4F6570;stroke:#EEF2F5;stroke-width:2}.pot-arrow{stroke:#F1C453;stroke-width:4}.pot-arrowhead{fill:#F1C453}.buzzer-body{fill:#212529;stroke:#0B0D10;stroke-width:2}.buzzer-hole{fill:#495057;stroke:#0B0D10;stroke-width:1}.sound-ring{fill:none;stroke:#E8590C;stroke-width:3;stroke-dasharray:6 5}.generic-body{fill:#5F7880;stroke:#E5F2F4;stroke-width:2}.mcu{fill:#1B3339;stroke:#90C5BD;stroke-width:3}.board-title{fill:#F3F7F8;font-weight:700;font-size:15px}.header-label{fill:#90C5BD;font-size:11px;font-weight:700}.header-pin{fill:#F2C94C;stroke:#12181D;stroke-width:2}.pin-label{fill:#F3F7F8;font-size:12px;font-weight:700}.pin-cue{fill:#1B1D2B;font-size:11px;font-weight:700}.part-label{fill:#1B1D2B;font-size:12px;font-weight:700}.label-bg{fill:#FFFFFF;stroke:#8D99AE;stroke-width:1}.leader{stroke:#5C6773;stroke-width:1.5}.wire-casing{fill:none;stroke:#1B1D2B;stroke-width:6.5;stroke-linecap:round;opacity:.55}.wire-path{fill:none;stroke-width:4;stroke-linecap:round}.wire-bg{fill:#1B1D2B}.wire-label{fill:#fff;font-size:11px;font-weight:700}.vb-old{opacity:.48}.part.vb-hl,.wire.vb-hl{filter:drop-shadow(0 0 5px #fff)}.vb-new{filter:drop-shadow(0 0 8px #f7d774)}.hole.vb-hl,.rail-hole.vb-hl{fill:#ffe166;stroke:#111;stroke-width:2}
</style><rect x="0" y="0" width="${width}" height="700" fill="${CANVAS_FILL}"/><rect x="${BOARD_LEFT - 36}" y="${RAIL_Y["T-"] - 22}" width="${BOARD_RIGHT - BOARD_LEFT + 72}" height="${RAIL_Y["B-"] - RAIL_Y["T-"] + 30}" rx="14" class="board-surface"/><rect x="${BOARD_LEFT - 4}" y="${CHANNEL_Y - 24}" width="${BOARD_RIGHT - BOARD_LEFT + 8}" height="48" class="channel"/>${renderRailLabels(input.layout)}${renderRowLabels(input.layout)}${columnLetters}${renderHoles(input.layout, input.highlight)}<g id="board">${renderBoard(input.layout, pins)}</g>${jumpers}${parts}<g class="legend"><rect x="${BOARD_RIGHT - 160}" y="${BOARD_TOP + 5}" width="148" height="42" rx="7" class="label-bg"/><text x="${BOARD_RIGHT - 150}" y="${BOARD_TOP + 22}" class="part-label">Rows left → right</text><text x="${BOARD_RIGHT - 150}" y="${BOARD_TOP + 38}" class="part-label">a–e top · f–j bottom</text></g></svg>`;
  const scopedSvg = scopeSvgStyles(svg);
  const backgroundSvg = focusBox ? scopedSvg.replace(`<rect x="0" y="0" width="${width}" height="700" fill="${CANVAS_FILL}"/>`, `<rect x="0" y="0" width="${width}" height="700" fill="${BOARD_FILL}"/>`) : scopedSvg;
  if (!focusBox) return backgroundSvg;
  const focusedSvg = backgroundSvg.replace(/class="base-row-label row-label"/g, `class="base-row-label row-label" style="display:none"`).replace(/class="base-column-label column-label"/g, `class="base-column-label column-label" style="display:none"`);
  return focusedSvg.replace(`<g id="focus-labels"></g>`, renderFocusLabels(input.layout, focusBox));
}
