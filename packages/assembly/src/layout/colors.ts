/**
 * Jumper wire colours (issue #15).
 *
 * Default rule: red = the 5 V net, black = GND. Every signal net belongs to a "line": an Arduino pin's net plus the
 * part-to-part nets behind it (D4 → R1 → LED1 is one line), and a line has one colour on every wire, in every step.
 * Lines doing the same job (all LED lines, all key lines) take consecutive colours in resistor-colour-code order
 * (orange, yellow, green, blue, purple, white), ordered by Arduino pin, so neighbouring lines always differ and the
 * legend reads "orange–yellow–green–blue = LED1–LED4 (D2–D5)".
 *
 * Overrides come from the builder: `wire:<jumper id>` recolours one wire, `net:<net id>` a whole net. Values are a kit
 * colour name or a custom `#rrggbb`.
 */
import { BOARD_PART, isWireColorValue, type Circuit, type Layout, type WireColor } from "@vibread/core";

/** Resistor-code order, skipping red/black (reserved for power) and brown/gray (hard to tell apart on a board). */
const SIGNAL_SEQUENCE: readonly WireColor[] = ["orange", "yellow", "green", "blue", "purple", "white"];

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
          if (assigned.has(other.id) || pinsOf(other.id).length > 0) continue;
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
    const modules = new Set<string | undefined>(rolePart ? [moduleOf(rolePart)] : parts.map(moduleOf));
    const [module, role] = ROLE_ORDER.find(([key]) => modules.has(key)) ?? ["", "line"];
    out.push({
      nets,
      boardPins: nets.flatMap(pinsOf).sort((a, b) => boardPinRank(a) - boardPinRank(b)),
      role,
      parts: rolePart ? [rolePart] : parts.filter((id) => moduleOf(id) === module),
    });
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
  let next = 0;
  for (const role of roles) {
    for (const line of all.filter((entry) => entry.role === role)) {
      const color = SIGNAL_SEQUENCE[next % SIGNAL_SEQUENCE.length]!;
      next += 1;
      for (const net of line.nets) colors[net] = color;
    }
  }
  return colors;
}

/** Effective colour of every net: the builder's `net:` override, else the suggestion. */
export function netColors(circuit: Circuit, overrides: WireColorOverrides = {}): Record<string, string> {
  const colors: Record<string, string> = { ...defaultNetColors(circuit) };
  for (const net of circuit.nets) {
    const override = overrides[`net:${net.id}`];
    if (isWireColorValue(override)) colors[net.id] = override;
  }
  return colors;
}

/** Effective colour of every jumper: `wire:` override, else its net's colour. */
export function jumperColors(circuit: Circuit, layout: Layout, overrides: WireColorOverrides = {}): Record<string, string> {
  const nets = netColors(circuit, overrides);
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
  const nets = netColors(circuit, overrides);
  const used = new Set(layout.jumpers.map((jumper) => jumper.net));
  const entries: WireLegendEntry[] = [];
  for (const net of circuit.nets.filter((entry) => entry.kind !== "signal" && used.has(entry.id))) {
    entries.push({ colors: [nets[net.id]!], label: net.kind === "power" ? `${net.id} (power)` : `${net.id} (ground)` });
  }
  const all = lines(circuit).filter((line) => line.nets.some((net) => used.has(net)));
  for (const role of [...new Set(all.map((line) => line.role))]) {
    const group = all.filter((line) => line.role === role);
    const parts = group.flatMap((line) => line.parts);
    const pins = group.flatMap((line) => line.boardPins);
    const label = `${parts.length > 0 ? range(parts) : `${role} lines`}${pins.length > 0 ? ` (${range(pins)})` : ""}`;
    entries.push({ colors: group.map((line) => nets[line.nets[0]!]!), label });
    // A part-to-part net the builder recoloured on its own gets its own entry.
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
