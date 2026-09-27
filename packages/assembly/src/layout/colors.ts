/**
 * Jumper wire colours (issue #15).
 *
 * Default rule: red = the 5 V net, black = GND. Every signal net belongs to a "line": an Arduino pin's net plus the
 * serial part-to-part nets behind it (D4 → R1 → LED1: the R1–LED1 net has exactly two members), and a line has one
 * colour on every wire, in every step. A part-to-part net with three or more members is a bus (5 V → R2 → every LED
 * anode) and is a line of its own. Lines doing the same job (all LED lines, all key lines) take consecutive colours
 * in resistor-colour-code order (orange, yellow, green, blue, purple, white), ordered by Arduino pin, so the legend
 * reads "orange–yellow–green–blue = LED1–LED4 (D2–D5)". Two lines that touch the same part never share a colour.
 *
 * Overrides come from the builder: `wire:<jumper id>` recolours one wire, `net:<net id>` a whole net. Values are a kit
 * colour name or a custom `#rrggbb`.
 */
import { BOARD_PART, isWireColorValue, type Circuit, type Layout, type WireColor } from "@vibread/core";

/** Resistor-code order, skipping red/black (reserved for power) and brown/gray (hard to tell apart on a board). */
const SIGNAL_SEQUENCE: readonly WireColor[] = ["orange", "yellow", "green", "blue", "purple", "white"];
/** Only when every sequence colour is taken by a touching line. */
const SPARE_SIGNAL_COLORS = ["brown", "gray"] as const;

export type WireColorOverrides = Record<string, string>;

export interface WireLegendEntry {
  /** Colour values (kit names or #rrggbb), one swatch each. */
  colors: string[];
  /** What they mean, e.g. "LED1–LED4 (D2–D5)". */
  label: string;
}

interface Line {
  /** Nets in the line, the Arduino pin's net first. */
  nets: string[];
  boardPins: string[];
  role: string;
  /** Parts that give the line its role (LEDs of LED lines …), for the legend. */
  parts: string[];
}

/** How build-step text names a colour: "orange", or "custom-colour (#12ab34)". */
export function wireColorName(value: string): string {
  return value.startsWith("#") ? `custom-colour (${value.toLowerCase()})` : value;
}

/** "an orange wire", "a blue wire", "a custom-colour (#12ab34) wire". */
export function aWire(value: string): string {
  const name = wireColorName(value);
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name} wire`;
}

function boardPinRank(pin: string): number {
  const match = /^([DA])(\d+)$/.exec(pin);
  if (match) return match[1] === "D" ? Number(match[2]) : 100 + Number(match[2]);
  return 300;
}

const ROLE_ORDER: [string, string][] = [
  ["led", "LED"],
  ["buzzer-active", "buzzer"],
  ["buzzer-passive", "buzzer"],
  ["button", "button"],
  ["potentiometer", "knob"],
  ["photoresistor", "light sensor"],
  ["generic", "module"],
  ["resistor", "resistor"],
];

/** Group signal nets into lines, Arduino pins in pin order first, then part-only islands. */
function lines(circuit: Circuit): Line[] {
  const signals = circuit.nets.filter((net) => net.kind === "signal");
  const partsOf = (netId: string) => signals.find((net) => net.id === netId)!.pins.filter((ref) => ref.part !== BOARD_PART).map((ref) => ref.part);
  const pinsOf = (netId: string) => signals.find((net) => net.id === netId)!.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin);
  const seeds = [...signals]
    .filter((net) => pinsOf(net.id).length > 0)
    .sort((a, b) => Math.min(...pinsOf(a.id).map(boardPinRank)) - Math.min(...pinsOf(b.id).map(boardPinRank)) || a.id.localeCompare(b.id));
  const assigned = new Set<string>();
  const out: Line[] = [];
  const grow = (seed: string) => {
    const nets = [seed];
    assigned.add(seed);
    for (let index = 0; index < nets.length; index += 1) {
      for (const part of partsOf(nets[index]!)) {
        for (const other of signals) {
          // Only serial links join the seed's line: a part-to-part net with exactly two members. A bus is its own line.
          if (assigned.has(other.id) || pinsOf(other.id).length > 0 || other.pins.length !== 2) continue;
          if (!other.pins.some((ref) => ref.part === part)) continue;
          assigned.add(other.id);
          nets.push(other.id);
        }
      }
    }
    const parts = [...new Set(nets.flatMap(partsOf))].sort();
    const moduleOf = (id: string) => circuit.parts.find((part) => part.id === id)?.module;
    // The sketch's pin role names the part the line is for (a key line with its LED is still a key line).
    const rolePart = circuit.roles.find((entry) => pinsOf(seed).includes(entry.pin) && parts.includes(entry.part))?.part;
    const boardPins = nets.flatMap(pinsOf).sort((a, b) => boardPinRank(a) - boardPinRank(b));
    // A part-to-part bus (3+ members, no Arduino pin) is named by its net, not by the parts it feeds.
    if (boardPins.length === 0 && partsOf(seed).length > 2) {
      out.push({ nets, boardPins, role: "bus", parts });
      return;
    }
    const modules = new Set<string | undefined>(rolePart ? [moduleOf(rolePart)] : parts.map(moduleOf));
    const [module, role] = ROLE_ORDER.find(([key]) => modules.has(key)) ?? ["", "line"];
    out.push({ nets, boardPins, role, parts: rolePart ? [rolePart] : parts.filter((id) => moduleOf(id) === module) });
  };
  for (const net of seeds) if (!assigned.has(net.id)) grow(net.id);
  for (const net of [...signals].sort((a, b) => a.id.localeCompare(b.id))) if (!assigned.has(net.id)) grow(net.id);
  return out;
}

/** Suggested colour of every net (the default rule above). */
export function defaultNetColors(circuit: Circuit): Record<string, WireColor> {
  const colors: Record<string, WireColor> = {};
  for (const net of circuit.nets) {
    if (net.kind === "power") colors[net.id] = "red";
    else if (net.kind === "ground") colors[net.id] = "black";
  }
  const all = lines(circuit);
  const roles = [...new Set(all.map((line) => line.role))];
  const ordered = roles.flatMap((role) => all.filter((entry) => entry.role === role));
  // Lines touching a common part are drawn next to each other and must differ (the sequence wraps after six).
  const partsOfLine = ordered.map((line) => new Set(circuit.nets.filter((net) => line.nets.includes(net.id)).flatMap((net) => net.pins.map((ref) => ref.part)).filter((part) => part !== BOARD_PART)));
  const chosen: WireColor[] = [];
  ordered.forEach((line, index) => {
    const neighbours = new Set(ordered.map((_, other) => other).filter((other) => other < index && [...partsOfLine[index]!].some((part) => partsOfLine[other]!.has(part))).map((other) => chosen[other]!));
    const palette = [...SIGNAL_SEQUENCE, ...SPARE_SIGNAL_COLORS];
    // A bus reaches across the drawing, so it prefers a colour no other line uses at all.
    const unused = line.role === "bus" ? palette.find((candidate) => !chosen.includes(candidate) && !ordered.slice(index + 1).some((_, later) => SIGNAL_SEQUENCE[(index + 1 + later) % SIGNAL_SEQUENCE.length] === candidate)) : undefined;
    const preferred = unused ?? SIGNAL_SEQUENCE[index % SIGNAL_SEQUENCE.length]!;
    const color = !neighbours.has(preferred) ? preferred : (palette.find((candidate) => !neighbours.has(candidate)) ?? preferred);
    chosen.push(color);
    for (const net of line.nets) colors[net] = color;
  });
  return colors;
}

/** Nets that share a colour with `netId`: its whole line (D5 and L2 behind the resistor), or just itself for 5V/GND. */
export function lineNets(circuit: Circuit, netId: string): string[] {
  return lines(circuit).find((line) => line.nets.includes(netId))?.nets ?? [netId];
}

/**
 * Effective colour of every net.
 * 1. A `net:` override recolours the net's whole line (the first overridden net of the line, Arduino side first, wins).
 * 2. Given the layout, a net whose wires all carry the same `wire:` override takes that colour (overriding the only
 *    D2 wire makes D2 that colour everywhere, schematic and legend included).
 * 3. Otherwise the suggestion.
 */
export function netColors(circuit: Circuit, overrides: WireColorOverrides = {}, layout?: Layout): Record<string, string> {
  const colors: Record<string, string> = { ...defaultNetColors(circuit) };
  const netOverride = (id: string) => (isWireColorValue(overrides[`net:${id}`]) ? overrides[`net:${id}`] : undefined);
  const signalLines = lines(circuit);
  for (const line of signalLines) {
    const override = line.nets.map(netOverride).find((value) => value !== undefined);
    if (override) for (const net of line.nets) colors[net] = override;
  }
  for (const net of circuit.nets.filter((entry) => entry.kind !== "signal")) {
    const override = netOverride(net.id);
    if (override) colors[net.id] = override;
  }
  if (layout) {
    for (const net of circuit.nets) {
      const wires = layout.jumpers.filter((jumper) => jumper.net === net.id).map((jumper) => overrides[`wire:${jumper.id}`]);
      const first = wires[0];
      if (isWireColorValue(first) && wires.every((value) => value === first)) colors[net.id] = first;
    }
  }
  return colors;
}

/** Effective colour of every jumper: `wire:` override, else its net's colour. */
export function jumperColors(circuit: Circuit, layout: Layout, overrides: WireColorOverrides = {}): Record<string, string> {
  const nets = netColors(circuit, overrides, layout);
  const colors: Record<string, string> = {};
  for (const jumper of layout.jumpers) {
    const override = overrides[`wire:${jumper.id}`];
    colors[jumper.id] = isWireColorValue(override) ? override : (nets[jumper.net] ?? jumper.color);
  }
  return colors;
}

function range(ids: string[]): string {
  return ids.length <= 1 ? (ids[0] ?? "") : ids.length === 2 ? `${ids[0]}, ${ids[1]}` : `${ids[0]}–${ids.at(-1)}`;
}

/** Short legend for the build view: one entry per group of same-role lines, plus 5 V / GND and any one-off wires. */
export function wireLegend(circuit: Circuit, layout: Layout, overrides: WireColorOverrides = {}): WireLegendEntry[] {
  const nets = netColors(circuit, overrides, layout);
  const used = new Set(layout.jumpers.map((jumper) => jumper.net));
  const entries: WireLegendEntry[] = [];
  for (const net of circuit.nets.filter((entry) => entry.kind !== "signal" && used.has(entry.id))) {
    entries.push({ colors: [nets[net.id]!], label: net.kind === "power" ? `${net.id} (power)` : `${net.id} (ground)` });
  }
  const all = lines(circuit).filter((line) => line.nets.some((net) => used.has(net)));
  for (const line of all.filter((entry) => entry.role === "bus")) {
    // "LED1–LED4, R2": one range per kind of part.
    const byPrefix = new Map<string, string[]>();
    for (const part of line.parts) {
      const prefix = part.replace(/\d+$/, "");
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), part]);
    }
    const members = [...byPrefix.values()].map((ids) => range(ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))).join(", ");
    entries.push({ colors: [nets[line.nets[0]!]!], label: `${line.nets[0]} bus (${members})` });
  }
  for (const role of [...new Set(all.map((line) => line.role))].filter((role) => role !== "bus")) {
    const group = all.filter((line) => line.role === role);
    const parts = group.flatMap((line) => line.parts);
    const pins = group.flatMap((line) => line.boardPins);
    const label = `${parts.length > 0 ? range(parts) : `${role} lines`}${pins.length > 0 ? ` (${range(pins)})` : ""}`;
    entries.push({ colors: group.map((line) => nets[line.nets[0]!]!), label });
    // A part-to-part net whose own wires were recoloured gets its own entry.
    for (const line of group) {
      for (const net of line.nets.slice(1)) if (used.has(net) && nets[net] !== nets[line.nets[0]!]) entries.push({ colors: [nets[net]!], label: `net ${net}` });
    }
  }
  for (const jumper of layout.jumpers) {
    const override = overrides[`wire:${jumper.id}`];
    if (isWireColorValue(override) && override !== nets[jumper.net]) entries.push({ colors: [override], label: `${jumper.id} (${jumper.net})` });
  }
  return entries;
}
