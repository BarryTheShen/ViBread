/**
 * "Parts for this step" panel (issue #22): the new part(s) drawn large, before insertion, with every leg named the way
 * the step text names it and its hole written at the leg's end. Drawings and facts come from `partVisual` (per module
 * and catalogue variant), never from per-step strings. Legs are laid out in the same left-to-right order as their holes
 * on the board, so the panel and the board read the same way round.
 */
import { parseHole, partVisual, resistorBands, formatOhms, type Circuit, type HoleId, type Jumper, type Layout, type Part, type PartVisual } from "@vibread/core";

/** Height of one drawn item (and of the whole panel at zoom 1), in 1200-wide picture units. */
export const PANEL_HEIGHT = 380;
const PANEL_WIDTH = 1200;
const MIN_CELL = 560;

export interface PanelAnchor {
  /** Panel-local point at the tip of a leg. */
  point: { x: number; y: number };
  hole: HoleId;
}

interface Cell {
  x: number;
  width: number;
}

interface PanelInput {
  circuit: Circuit;
  layout: Layout;
  parts: string[];
  jumpers: string[];
  /** A wire's CSS colour (the builder's choice or the suggested one). */
  wireCss: (jumper: Jumper) => string;
  /** Part colour name → CSS colour. */
  css: (name: string) => string;
  /** Resistor colour-band name → CSS colour (same as the board drawing's bands). */
  bandCss: (name: string) => string;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function text(x: number, y: number, value: string, cls: string, anchor: "start" | "middle" | "end" = "middle"): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${esc(value)}</text>`;
}

/** Column (numbered) and row index (a=0 … j=9) of a hole, for ordering legs the way they sit on the board. */
function holeOrder(hole: HoleId): [number, number] {
  const parsed = parseHole(hole);
  if (!parsed) return [0, 0];
  return parsed.kind === "terminal" ? [parsed.row, "abcdefghij".indexOf(parsed.column)] : [parsed.position, parsed.rail.startsWith("T") ? -1 : 10];
}

function byBoardOrder(pins: Record<string, HoleId>, legs: PartVisual["legs"]): PartVisual["legs"] {
  return [...legs].filter((leg) => pins[leg.pin]).sort((a, b) => {
    const [ca, ra] = holeOrder(pins[a.pin]!);
    const [cb, rb] = holeOrder(pins[b.pin]!);
    return ca - cb || ra - rb;
  });
}

function leg(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="panel-leg"/>`;
}

function holeTag(x: number, y: number, hole: HoleId): string {
  return `<g class="panel-hole">${text(x, y, hole, "panel-hole-text")}</g>`;
}

function title(cell: Cell, value: string): string {
  return text(cell.x + cell.width / 2, 46, value, "panel-title");
}

function drawLed(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell, css: (name: string) => string): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const legs = byBoardOrder(pins, visual.legs);
  const color = css(typeof part.params.color === "string" ? part.params.color : "red");
  const cathodeRight = legs.findIndex((entry) => entry.length === "short") === legs.length - 1;
  // Rim with the flat side on the cathode's side.
  const rimLeft = cx - 56;
  const rimRight = cx + 56;
  const rim = cathodeRight
    ? `M ${rimLeft} 176 L ${rimLeft} 160 L ${rimRight - 10} 160 L ${rimRight - 10} 176 Z`
    : `M ${rimLeft + 10} 176 L ${rimLeft + 10} 160 L ${rimRight} 160 L ${rimRight} 176 Z`;
  const parts: string[] = [
    title(cell, `${part.id} · ${typeof part.params.color === "string" ? part.params.color : "red"} ${visual.name}`),
    `<path d="${rim}" class="panel-body"/>`,
    `<path d="M ${cx - 46} 162 L ${cx - 46} 118 A 46 46 0 0 1 ${cx + 46} 118 L ${cx + 46} 162 Z" fill="${color}" class="panel-led"/>`,
    text(cathodeRight ? rimRight + 4 : rimLeft - 4, 150, "flat side", "panel-note", cathodeRight ? "start" : "end"),
  ];
  const anchors: PanelAnchor[] = [];
  legs.forEach((entry, index) => {
    const x = cx + (index === 0 ? -20 : 20);
    const end = entry.length === "long" ? 320 : 282;
    parts.push(leg(x, 176, x, end));
    const outer = index === 0 ? "end" : "start";
    const tx = x + (index === 0 ? -26 : 26);
    const [first, ...rest] = entry.label.split(" (");
    parts.push(text(tx, 232, first!, entry.label.startsWith("+") ? "panel-plus" : entry.label.startsWith("−") ? "panel-minus" : "panel-label", outer));
    if (rest.length > 0) parts.push(text(tx, 266, rest.join(" (").replace(/\)$/, ""), "panel-note", outer));
    parts.push(holeTag(x, end + 36, pins[entry.pin]!));
    anchors.push({ point: { x, y: end }, hole: pins[entry.pin]! });
  });
  return { svg: parts.join(""), anchors };
}

function drawTwoLead(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell, body: string, lines: string[], bodyHalf: number): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const legs = byBoardOrder(pins, visual.legs);
  const reach = Math.min(250, cell.width / 2 - 40);
  const parts: string[] = [body];
  const anchors: PanelAnchor[] = [];
  legs.forEach((entry, index) => {
    const x = index === 0 ? cx - reach : cx + reach;
    parts.push(leg(index === 0 ? cx - bodyHalf : cx + bodyHalf, 150, x, 150));
    parts.push(holeTag(x, 196, pins[entry.pin]!));
    anchors.push({ point: { x, y: 150 }, hole: pins[entry.pin]! });
  });
  lines.forEach((line, index) => parts.push(text(cx, 262 + index * 38, line, index === 0 ? "panel-label" : "panel-note")));
  return { svg: parts.join(""), anchors };
}

function drawResistor(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell, band: (name: string) => string): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const ohms = Number(part.params.ohms);
  const bands = resistorBands(ohms, Number(part.params.tolerancePct ?? 5));
  const bandSvg = bands.map((name, index) => `<rect x="${cx - 84 + index * 36}" y="122" width="16" height="56" fill="${band(name)}"/>`).join("");
  const body = `${title(cell, `${part.id} · ${formatOhms(ohms)} resistor`)}<rect x="${cx - 120}" y="118" width="240" height="64" rx="22" class="panel-resistor"/>${bandSvg}`;
  return drawTwoLead(part, visual, pins, cell, body, [bands.join("-"), visual.orientation], 120);
}

function drawPhotoresistor(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const body = `${title(cell, `${part.id} · light sensor`)}<circle cx="${cx}" cy="150" r="56" class="panel-sensor"/><path d="M ${cx - 34} 150 l 12 -18 12 36 12 -36 12 36 12 -18" class="panel-squiggle"/>`;
  return drawTwoLead(part, visual, pins, cell, body, ["light sensor", visual.orientation], 56);
}

function drawVertical(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell, body: (cx: number, legXs: Map<string, number>) => string, heading: string, bodyHalf: number): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const legs = byBoardOrder(pins, visual.legs);
  const spacing = Math.min(210, (cell.width - 80) / Math.max(1, legs.length));
  const legXs = new Map(legs.map((entry, index) => [entry.pin, cx + (index - (legs.length - 1) / 2) * spacing]));
  const parts: string[] = [title(cell, heading)];
  const anchors: PanelAnchor[] = [];
  legs.forEach((entry) => {
    const x = legXs.get(entry.pin)!;
    const end = entry.length === "long" ? 290 : entry.length === "short" ? 262 : 276;
    // Legs leave the underside of the body and bend out to where their holes are.
    const root = cx + Math.max(-bodyHalf, Math.min(bodyHalf, x - cx));
    parts.push(`<polyline points="${root},196 ${root},210 ${x},232 ${x},${end}" class="panel-leg panel-leg-bent"/>`);
    parts.push(text(x, end + 32, entry.label.replace(/ \(.+\)$/, ""), entry.label.startsWith("+") ? "panel-plus-small" : entry.label.startsWith("−") ? "panel-minus-small" : "panel-note"));
    parts.push(holeTag(x, end + 68, pins[entry.pin]!));
    anchors.push({ point: { x, y: end }, hole: pins[entry.pin]! });
  });
  parts.push(body(cx, legXs));
  return { svg: parts.join(""), anchors };
}

function drawButton(part: Part, visual: PartVisual, pins: Record<string, HoleId>, cell: Cell): { svg: string; anchors: PanelAnchor[] } {
  const cx = cell.x + cell.width / 2;
  const cy = 184;
  const half = 58;
  // Legs at the body's corners, placed like their holes: left/right by column, top/bottom by row (a–e above f–j).
  const legs = visual.legs.filter((entry) => pins[entry.pin]);
  const columns = [...new Set(legs.map((entry) => holeOrder(pins[entry.pin]!)[0]))].sort((a, b) => a - b);
  const rows = [...new Set(legs.map((entry) => holeOrder(pins[entry.pin]!)[1]))].sort((a, b) => a - b);
  const parts: string[] = [
    title(cell, `${part.id} · push button`),
    `<rect x="${cell.x + 40}" y="${cy - 16}" width="${cell.width - 80}" height="32" class="panel-channel"/>`,
    text(cell.x + 48, cy + 8, "centre channel", "panel-channel-text", "start"),
  ];
  const anchors: PanelAnchor[] = [];
  const tips = new Map<string, { x: number; y: number }>();
  for (const entry of legs) {
    const [column, row] = holeOrder(pins[entry.pin]!);
    const left = columns.length < 2 || column === columns[0];
    const top = rows.length < 2 || row === rows[0];
    const corner = { x: cx + (left ? -half : half), y: cy + (top ? -half : half) };
    const tip = { x: corner.x + (left ? -70 : 70), y: corner.y + (top ? -34 : 34) };
    tips.set(entry.pin, tip);
    parts.push(leg(corner.x, corner.y, tip.x, tip.y));
    parts.push(text(tip.x + (left ? -14 : 14), tip.y + 4, entry.short, "panel-label", left ? "end" : "start"));
    parts.push(`<text x="${tip.x + (left ? -14 : 14)}" y="${tip.y + 36}" text-anchor="${left ? "end" : "start"}" class="panel-hole-text">${esc(pins[entry.pin]!)}</text>`);
    anchors.push({ point: tip, hole: pins[entry.pin]! });
  }
  // Pins joined inside the part: a translucent bar between their tips.
  for (const pair of visual.joined ?? []) {
    const [a, b] = pair.map((pin) => tips.get(pin));
    if (a && b) parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="panel-joined"/>`);
  }
  parts.push(`<rect x="${cx - half}" y="${cy - half}" width="${half * 2}" height="${half * 2}" rx="10" class="panel-body"/><circle cx="${cx}" cy="${cy}" r="36" class="panel-cap"/>`);
  parts.push(text(cx, 352, (visual.joined ?? []).map((pair) => `${pair.join("–")} always joined`).join(" · "), "panel-note"));
  return { svg: parts.join(""), anchors };
}

function drawWire(jumper: Jumper, cell: Cell, css: string): string {
  const x1 = cell.x + 90;
  const x2 = cell.x + cell.width - 90;
  const where = (end: Jumper["from"]) => ("board" in end ? `Arduino pin ${end.board}` : `hole ${end.hole}`);
  const long = "board" in jumper.from || "board" in jumper.to;
  return [
    title(cell, `${jumper.id} · ${jumper.net} wire`),
    `<path d="M ${x1} 150 C ${x1 + 60} 80, ${x2 - 60} 80, ${x2} 150" class="panel-wire-casing"/><path d="M ${x1} 150 C ${x1 + 60} 80, ${x2 - 60} 80, ${x2} 150" stroke="${css}" class="panel-wire"/>`,
    ...([[x1, 1], [x2, 2]] as const).map(([x, n]) => `<circle cx="${x}" cy="150" r="22" class="panel-badge" stroke="${css}"/>${text(x, 161, String(n), "panel-badge-text")}`),
    text(cell.x + cell.width / 2, 226, `1 · ${where(jumper.from)}`, "panel-label"),
    text(cell.x + cell.width / 2, 270, `2 · ${where(jumper.to)}`, "panel-label"),
    text(cell.x + cell.width / 2, 316, long ? "long wire: reaches the Arduino" : "short wire", "panel-note"),
  ].join("");
}

/**
 * The panel for one step's new parts and wires, or undefined when the step adds nothing. The panel always has the same
 * size (1200 × PANEL_HEIGHT·zoom), so every step picture of a kind has one aspect ratio and a phone frame never jumps:
 * items share it in one row (two rows beyond two items), each drawn in a cell at least MIN_CELL wide and scaled to
 * fit. `zoom` > 1 gives a phone-sized picture a taller panel, so a lone item is drawn larger.
 */
export function renderPartsPanel(input: PanelInput, zoom = 1): { svg: string; anchors: PanelAnchor[]; width: number; height: number } | undefined {
  const items = input.parts.length + input.jumpers.length;
  if (items === 0) return undefined;
  const width = PANEL_WIDTH;
  const height = Math.round(PANEL_HEIGHT * zoom);
  const rows = items > 2 ? 2 : 1;
  const columns = Math.ceil(items / rows);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const scale = Math.min(cellWidth / MIN_CELL, cellHeight / PANEL_HEIGHT);
  const nominal = cellWidth / scale;
  const origin = (index: number) => ({ x: (index % columns) * cellWidth, y: Math.floor(index / columns) * cellHeight + (cellHeight - PANEL_HEIGHT * scale) / 2 });
  const place = (index: number, svg: string) => `<g transform="translate(${origin(index).x} ${origin(index).y}) scale(${scale})">${svg}</g>`;
  const toPanel = (index: number, anchor: PanelAnchor): PanelAnchor => ({ hole: anchor.hole, point: { x: origin(index).x + anchor.point.x * scale, y: origin(index).y + anchor.point.y * scale } });
  const out: string[] = [`<rect x="12" y="10" width="${width - 24}" height="${height - 20}" rx="18" class="panel-card"/>`];
  const anchors: PanelAnchor[] = [];
  let index = 0;
  for (const id of input.parts) {
    const part = input.circuit.parts.find((entry) => entry.id === id);
    const pins = input.layout.placements.find((entry) => entry.part === id)?.pins;
    if (!part || !pins) continue;
    const cell = { x: 0, width: nominal };
    const visual = partVisual(part);
    const drawn = visual.drawing === "led"
      ? drawLed(part, visual, pins, cell, input.css)
      : visual.drawing === "resistor"
        ? drawResistor(part, visual, pins, cell, input.bandCss)
        : visual.drawing === "photoresistor"
          ? drawPhotoresistor(part, visual, pins, cell)
          : visual.drawing === "button4"
            ? drawButton(part, visual, pins, cell)
            : visual.drawing === "button2"
              // Two equal legs in one half of the board: no channel to straddle, no leg names, either way round.
              ? drawVertical(part, visual, pins, cell, (cx) => `${text(cx, 86, visual.orientation.split(";")[0]!, "panel-note")}<rect x="${cx - 60}" y="112" width="120" height="84" rx="10" class="panel-body"/><circle cx="${cx}" cy="154" r="28" class="panel-cap"/>`, `${part.id} · push button`, 50)
            : visual.drawing === "buzzer"
              ? drawVertical(part, visual, pins, cell, (cx, legXs) => {
                  // The + printed on top sits on the + leg's side, as on the real part.
                  const plus = visual.legs.find((entry) => entry.label.startsWith("+"));
                  const side = plus && (legXs.get(plus.pin) ?? cx) > cx ? 1 : -1;
                  return `<circle cx="${cx}" cy="134" r="64" class="panel-buzzer"/><circle cx="${cx}" cy="134" r="16" class="panel-buzzer-hole"/>${text(cx + side * 36, 124, "+", "panel-plus-on-dark")}`;
                }, `${part.id} · ${visual.name.toLowerCase()}`, 30)
              : visual.drawing === "potentiometer"
                ? drawVertical(part, visual, pins, cell, (cx) => `<rect x="${cx - 90}" y="112" width="180" height="88" rx="14" class="panel-body"/><circle cx="${cx}" cy="138" r="34" class="panel-cap"/><line x1="${cx}" y1="138" x2="${cx + 22}" y2="112" class="panel-knob-mark"/>`, `${part.id} · knob`, 70)
                : drawVertical(part, visual, pins, cell, (cx) => `<rect x="${cx - Math.min(260, nominal / 2 - 40)}" y="92" width="${Math.min(520, nominal - 80)}" height="108" rx="10" class="panel-body"/>${text(cx, 156, visual.name, "panel-body-text")}`, `${part.id} · ${visual.name}`, Math.min(240, nominal / 2 - 60));
    out.push(`<g data-panel-part="${esc(part.id)}">${place(index, drawn.svg)}</g>`);
    anchors.push(...drawn.anchors.map((anchor) => toPanel(index, anchor)));
    index += 1;
  }
  for (const id of input.jumpers) {
    const jumper = input.layout.jumpers.find((entry) => entry.id === id);
    if (!jumper) continue;
    out.push(`<g data-panel-wire="${esc(jumper.id)}">${place(index, drawWire(jumper, { x: 0, width: nominal }, input.wireCss(jumper)))}</g>`);
    index += 1;
  }
  return { svg: out.join(""), anchors, width, height };
}

/** Panel styles (scoped by the caller like the rest of the drawing). */
export const PANEL_CSS = [
  ".panel-card{fill:#F6F8FA;stroke:#AEB6BF;stroke-width:2}",
  ".panel-title{fill:#1B1D2B;font-size:34px;font-weight:700}",
  ".panel-label{fill:#1B1D2B;font-size:30px;font-weight:700}",
  ".panel-note{fill:#3B4552;font-size:26px}",
  ".panel-plus{fill:#C92A2A;font-size:34px;font-weight:800}",
  ".panel-minus{fill:#1864AB;font-size:34px;font-weight:800}",
  ".panel-plus-on-dark{fill:#FF6B6B;font-size:40px;font-weight:800}",
  ".panel-leg-bent{fill:none;stroke-linejoin:round}",
  ".panel-plus-small{fill:#C92A2A;font-size:26px;font-weight:800}",
  ".panel-minus-small{fill:#1864AB;font-size:26px;font-weight:800}",
  ".panel-leg{stroke:#7B8794;stroke-width:7;stroke-linecap:round}",
  ".panel-hole-text{fill:#E8590C;font-size:28px;font-weight:800}",
  ".panel-body{fill:#2B303B;stroke:#1B1D2B;stroke-width:2}",
  ".panel-body-text{fill:#fff;font-size:28px;font-weight:700}",
  ".panel-led{stroke:#1B1D2B;stroke-width:2;fill-opacity:.9}",
  ".panel-resistor{fill:#E9D3A8;stroke:#8C6B3E;stroke-width:2}",
  ".panel-sensor{fill:#E9D3A8;stroke:#8C6B3E;stroke-width:3}",
  ".panel-squiggle{fill:none;stroke:#8C2F1B;stroke-width:5;stroke-linejoin:round}",
  ".panel-cap{fill:#D9480F;stroke:#1B1D2B;stroke-width:2}",
  ".panel-knob-mark{stroke:#fff;stroke-width:5;stroke-linecap:round}",
  ".panel-channel{fill:#D5DAE0}",
  ".panel-channel-text{fill:#5C6773;font-size:20px;font-weight:700}",
  ".panel-joined{stroke:#E8590C;stroke-width:10;stroke-opacity:.35;stroke-linecap:round}",
  ".panel-buzzer{fill:#1B1D2B}",
  ".panel-buzzer-hole{fill:#495057}",
  ".panel-wire{fill:none;stroke-width:12;stroke-linecap:round}",
  ".panel-wire-casing{fill:none;stroke:#1B1D2B;stroke-width:17;stroke-linecap:round;opacity:.55}",
  ".panel-badge{fill:#fff;stroke-width:5}",
  ".panel-badge-text{fill:#1B1D2B;font-size:28px;font-weight:800}",
  ".panel-arrow{fill:none;stroke:#E8590C;stroke-width:3;stroke-dasharray:10 7}",
  ".panel-arrow-head{fill:#E8590C}",
].join("");
