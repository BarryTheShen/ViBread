/**
 * Repeated functional units (design philosophy rule 2, HOW-IT-WORKS.md "Design philosophy"): the same small circuit
 * built several times, differing only in its Arduino pin, e.g. D3 → R1 → LED1 → GND … D7 → R5 → LED5 → GND, or a key
 * button from D2 to GND. The allocator builds each set of copies identically at a fixed pitch, the quality score
 * checks that it did, and build steps can say "repeat ×N".
 *
 * Found from the netlist alone:
 * - chain: Arduino signal pin → two-lead part → private net (exactly two part pins) → two-lead part → rail net
 *   (the Arduino 5 V or GND net);
 * - button: a four-leg button with one joined pair on its own Arduino signal pin and the other pair on a rail net.
 * Placement groups made of whole units combine them: each group of a same-shaped family is one composite unit (the
 * whack-a-mole's "button + resistor + light" groups). Copies run left to right in the order the design asks for,
 * strongest first: a row placement group listing one part per copy (["LED5","LED4",…]); positions the part labels or
 * pin roles state ("Moon light 1 (leftmost)"); else ascending Arduino pins. The allocator then turns the Uno (USB end
 * left or right) so the wires run parallel for that order.
 */
import { BOARD_PART, MODULES, partVariant, type Circuit, type Part } from "@vibread/core";


/** One part of a unit: the pin facing the Arduino signal and the pin facing the rail. */
export interface UnitMember {
  part: string;
  enter: string;
  exit: string;
}

export interface Unit {
  kind: "chain" | "button";
  /** Chain: signal end first. Button: the button. */
  members: UnitMember[];
  boardPin: string;
  signalNet: string;
  /** Net between the two chain parts (chains only). */
  linkNet?: string;
  /** The rail net the unit ends on. */
  railNet: string;
}

/** A unit, or a placement group of whole units (composite), copied several times. */
export interface UnitCopy {
  units: Unit[];
  parts: string[];
}

export interface UnitSet {
  signature: string;
  /** Left to right as they should be built. */
  copies: UnitCopy[];
  /** Why this order (strongest first): a row placement group, positions the part labels state, ascending pins. */
  orderedBy: "placement group" | "part labels" | "pin order";
}

function railNets(circuit: Circuit): Set<string> {
  const out = new Set<string>();
  for (const net of circuit.nets) {
    const pins = net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin);
    if ((net.kind === "ground" && pins.includes("GND")) || (net.kind === "power" && pins.includes("5V"))) out.add(net.id);
  }
  return out;
}

function isTwoLead(part: Part): boolean {
  const footprint = MODULES[part.module].footprint;
  const variant = partVariant(part)?.footprint;
  return footprint.kind === "two-lead" && (variant === undefined || variant.kind === "two-lead");
}

/** The part-side end of a unit that can lean into a rail hole: not a rigid-legged buzzer. */
function reachesRail(part: Part): boolean {
  return isTwoLead(part) && !part.module.startsWith("buzzer");
}

function memberSignature(part: Part, member: UnitMember): string {
  // Values that make copies look different on the board; an LED's colour does not change how it is built.
  const value = part.module === "resistor" ? `${Number(part.params.ohms)}` : typeof part.params.variant === "string" ? part.params.variant : "";
  return `${part.module}(${value}):${member.enter}>${member.exit}`;
}

/** Every chain and button unit of the circuit (repeated or not). */
export function findUnits(circuit: Circuit): Unit[] {
  const rails = railNets(circuit);
  const netOf = new Map<string, string>();
  for (const net of circuit.nets) for (const ref of net.pins) netOf.set(`${ref.part}.${ref.pin}`, net.id);
  const parts = new Map(circuit.parts.map((part) => [part.id, part]));
  const units: Unit[] = [];
  for (const net of circuit.nets) {
    if (net.kind === "power" || net.kind === "ground" || rails.has(net.id)) continue;
    const boardPins = net.pins.filter((ref) => ref.part === BOARD_PART);
    const partPins = net.pins.filter((ref) => ref.part !== BOARD_PART);
    if (boardPins.length !== 1 || partPins.length === 0) continue;
    const boardPin = boardPins[0]!.pin;
    const first = parts.get(partPins[0]!.part);
    if (!first || partPins.some((ref) => ref.part !== first.id)) continue;
    if (first.module === "button" && MODULES.button.footprint.kind === "button4" && partVariant(first)?.footprint.kind !== "button2") {
      // One joined pair on the signal, the other pair on a rail.
      const pairs = MODULES.button.internallyConnected ?? [];
      const signalPair = pairs.find((pair) => pair.some((pin) => partPins.some((ref) => ref.pin === pin)));
      const railPair = pairs.find((pair) => pair !== signalPair);
      const railNet = railPair?.map((pin) => netOf.get(`${first.id}.${pin}`)).find((id) => id !== undefined);
      if (!signalPair || !railPair || !railNet || !rails.has(railNet)) continue;
      if (railPair.some((pin) => { const id = netOf.get(`${first.id}.${pin}`); return id !== undefined && id !== railNet; })) continue;
      units.push({ kind: "button", members: [{ part: first.id, enter: signalPair[0]!, exit: railPair[0]! }], boardPin, signalNet: net.id, railNet });
      continue;
    }
    if (partPins.length !== 1 || !isTwoLead(first)) continue;
    const enter = partPins[0]!.pin;
    const exit = MODULES[first.module].pins.map((pin) => pin.id).find((id) => id !== enter)!;
    const linkNet = netOf.get(`${first.id}.${exit}`);
    const link = circuit.nets.find((entry) => entry.id === linkNet);
    if (!link || rails.has(link.id) || link.kind !== "signal" || link.pins.length !== 2 || link.pins.some((ref) => ref.part === BOARD_PART)) continue;
    const next = link.pins.find((ref) => ref.part !== first.id);
    const second = next ? parts.get(next.part) : undefined;
    if (!next || !second || !reachesRail(second)) continue;
    const secondExit = MODULES[second.module].pins.map((pin) => pin.id).find((id) => id !== next.pin)!;
    const railNet = netOf.get(`${second.id}.${secondExit}`);
    if (!railNet || !rails.has(railNet)) continue;
    units.push({ kind: "chain", members: [{ part: first.id, enter, exit }, { part: second.id, enter: next.pin, exit: secondExit }], boardPin, signalNet: net.id, linkNet: link.id, railNet });
  }
  return units;
}

function unitSignature(circuit: Circuit, unit: Unit): string {
  const parts = new Map(circuit.parts.map((part) => [part.id, part]));
  const rail = circuit.nets.find((net) => net.id === unit.railNet)?.kind ?? "";
  return `${unit.kind}[${unit.members.map((member) => memberSignature(parts.get(member.part)!, member)).join("|")}]>${rail}`;
}

/** Arduino pin order: D0 … D13, then A0 … A5 (the default left-to-right order of units: ascending pins). */
export function pinNumber(pin: string): number {
  const match = /^([DA])(\d+)$/.exec(pin);
  return match ? (match[1] === "D" ? Number(match[2]) : 100 + Number(match[2])) : 300;
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };

/**
 * A spatial position a part's label or pin-role purpose states, read conservatively: "leftmost", "rightmost",
 * "2 from left", "second from the right", "light 3 from left". Anything else (e.g. "middle") says nothing.
 */
export function statedPosition(text: string): { from: "left" | "right"; k: number } | undefined {
  const lower = text.toLowerCase();
  if (/\bleft-?most\b/.test(lower)) return { from: "left", k: 1 };
  if (/\bright-?most\b/.test(lower)) return { from: "right", k: 1 };
  const match = /\b(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth)(?:st|nd|rd|th)?\s+(?:[a-z]+\s+)?from\s+(?:the\s+)?(left|right)\b/.exec(lower);
  if (!match) return undefined;
  const k = /^\d+$/.test(match[1]!) ? Number(match[1]) : ORDINALS[match[1]!]!;
  return k >= 1 ? { from: match[2] as "left" | "right", k } : undefined;
}

/** What a part's label and its pin roles' purposes say about where it sits among `count` like parts (0 = leftmost). */
export function statedIndex(circuit: Circuit, partId: string, count: number): number | undefined {
  const part = circuit.parts.find((entry) => entry.id === partId);
  const texts = [part?.label ?? "", ...circuit.roles.filter((role) => role.part === partId).map((role) => role.purpose)];
  for (const text of texts) {
    const stated = statedPosition(text);
    if (stated && stated.k <= count) return stated.from === "left" ? stated.k - 1 : count - stated.k;
  }
  return undefined;
}

/**
 * Left-to-right order for copies: the positions their parts' labels state first ("Moon light 1 (leftmost)"), the rest
 * filling the free places in ascending Arduino-pin order. Returns the copies reordered and whether labels decided it.
 */
function orderCopies<T>(circuit: Circuit, copies: T[], partsOf: (copy: T) => string[], pinOf: (copy: T) => string): { ordered: T[]; byLabels: boolean } {
  const stated = copies.map((copy) => partsOf(copy).map((id) => statedIndex(circuit, id, copies.length)).find((index) => index !== undefined));
  const byPin = copies.map((copy, index) => ({ copy, index })).sort((a, b) => pinNumber(pinOf(a.copy)) - pinNumber(pinOf(b.copy)));
  const slots: (T | undefined)[] = copies.map(() => undefined);
  let byLabels = false;
  copies.forEach((copy, index) => {
    const at = stated[index];
    if (at !== undefined && slots[at] === undefined) {
      slots[at] = copy;
      byLabels = true;
    }
  });
  const rest = byPin.filter((entry) => !slots.includes(entry.copy)).map((entry) => entry.copy);
  return { ordered: slots.map((slot) => slot ?? rest.shift()!), byLabels };
}

/** The allocator scores many candidate layouts of one circuit; its repeated units are worked out once. */
const setsCache = new WeakMap<Circuit, UnitSet[]>();

/** Sets of two or more identical units (or identical groups of units), each ordered left to right. */
export function repeatedUnits(circuit: Circuit): UnitSet[] {
  const cached = setsCache.get(circuit);
  if (cached) return cached;
  const sets = findRepeatedUnits(circuit);
  setsCache.set(circuit, sets);
  return sets;
}

function findRepeatedUnits(circuit: Circuit): UnitSet[] {
  const units = findUnits(circuit);
  const unitOfPart = new Map<string, Unit>();
  for (const unit of units) for (const member of unit.members) unitOfPart.set(member.part, unit);
  const groups = circuit.placement?.groups ?? [];
  const sets: UnitSet[] = [];
  const used = new Set<Unit>();

  // Placement groups made of whole units, several with the same shape: each group is one composite copy, left to right
  // in the groups' own order.
  const composites = groups.map((group) => {
    const members = [...new Set(group.map((id) => unitOfPart.get(id)))];
    if (members.some((unit) => unit === undefined)) return undefined;
    const whole = (members as Unit[]).every((unit) => unit.members.every((member) => group.includes(member.part)));
    if (!whole || members.length < 2) return undefined;
    // Units within the group in ascending pin order too, so each copy looks the same whichever way the Uno faces.
    const ordered = (members as Unit[]).sort((a, b) => pinNumber(a.boardPin) - pinNumber(b.boardPin));
    return { group, units: ordered, signature: ordered.map((unit) => unitSignature(circuit, unit)).join("+") };
  });
  const bySignature = new Map<string, NonNullable<(typeof composites)[number]>[]>();
  for (const entry of composites) if (entry) bySignature.set(entry.signature, [...(bySignature.get(entry.signature) ?? []), entry]);
  for (const [signature, entries] of bySignature) {
    if (entries.length < 2) continue;
    // "Each light next to its button" fixes what sits together, not the order of the groups: labels' stated positions,
    // else ascending pins (the layout then turns the Uno so the wires run parallel).
    const { ordered, byLabels } = orderCopies(circuit, entries, (entry) => entry.group, (entry) => entry.units[0]!.boardPin);
    sets.push({ signature, copies: ordered.map((entry) => ({ units: entry.units, parts: entry.units.flatMap((unit) => unit.members.map((m) => m.part)) })), orderedBy: byLabels ? "part labels" : "pin order" });
    for (const entry of entries) for (const unit of entry.units) used.add(unit);
  }

  // Single units with the same shape.
  const singles = new Map<string, Unit[]>();
  for (const unit of units) if (!used.has(unit)) singles.set(unitSignature(circuit, unit), [...(singles.get(unitSignature(circuit, unit)) ?? []), unit]);
  for (const [signature, members] of singles) {
    if (members.length < 2) continue;
    // A placement group listing one part of each copy fixes their order ("LED5, LED4 … LED1, left to right").
    const orderGroup = groups.find((group) => {
      const hit = members.filter((unit) => unit.members.some((m) => group.includes(m.part)));
      return hit.length >= 2 && group.every((id) => members.some((unit) => unit.members.some((m) => m.part === id))) && hit.every((unit) => unit.members.filter((m) => group.includes(m.part)).length === 1);
    });
    let ordered: Unit[];
    let orderedBy: UnitSet["orderedBy"];
    if (orderGroup) {
      const listed = (unit: Unit) => orderGroup.findIndex((id) => unit.members.some((m) => m.part === id));
      ordered = [...members].sort((a, b) => listed(a) - listed(b));
      orderedBy = "placement group";
    } else {
      const result = orderCopies(circuit, members, (unit) => unit.members.map((m) => m.part), (unit) => unit.boardPin);
      ordered = result.ordered;
      orderedBy = result.byLabels ? "part labels" : "pin order";
    }
    sets.push({ signature, copies: ordered.map((unit) => ({ units: [unit], parts: unit.members.map((m) => m.part) })), orderedBy });
  }
  return sets.sort((a, b) => b.copies.length - a.copies.length || a.signature.localeCompare(b.signature));
}
