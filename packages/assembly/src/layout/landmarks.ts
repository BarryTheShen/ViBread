/**
 * Landmarks (issue #22): where a new leg or wire end goes relative to what is already on the board. Every landmark is
 * computed from the layout and can be re-checked with `landmarkHolds`; nothing is free text.
 *
 * Vocabulary (matches the picture): numbered columns 1–63 run left to right, lettered rows a–j run top to bottom,
 * and the 5 holes of one column on one side of the centre channel (a–e or f–j) are one connected strip.
 */
import {
  BREADBOARD_PROFILES,
  contactGroup,
  parseHole,
  partVisual,
  type Circuit,
  type HoleId,
  type Jumper,
  type Layout,
  type LandmarkRef,
  type StepLandmark,
} from "@vibread/core";
import { wireColorName } from "./colors.js";
import { boardHeaderRows } from "./svg.js";

/** Something already on the board before this step. */
export interface Earlier {
  ref: LandmarkRef;
  /** "LED1's short leg", "the black wire's end". */
  label: string;
}

function column(hole: HoleId): number | undefined {
  const parsed = parseHole(hole);
  return parsed === null ? undefined : parsed.kind === "terminal" ? parsed.row : parsed.position;
}

/** "top" (a–e), "bottom" (f–j), or the rail it is on. */
function side(hole: HoleId): string | undefined {
  const parsed = parseHole(hole);
  if (!parsed) return undefined;
  return parsed.kind === "terminal" ? ("abcde".includes(parsed.column) ? "top" : "bottom") : parsed.rail;
}

/** How to name one leg of a placed part: its visual name, or left/right for look-alike legs. */
export function legName(circuit: Circuit, layout: Layout, partId: string, pin: string): string {
  const part = circuit.parts.find((entry) => entry.id === partId)!;
  const visual = partVisual(part);
  const leg = visual.legs.find((entry) => entry.pin === pin);
  const alike = visual.legs.length === 2 && visual.legs.every((entry) => entry.length === "equal");
  if (!alike) return leg?.short ?? pin;
  const pins = layout.placements.find((placement) => placement.part === partId)?.pins ?? {};
  const own = column(pins[pin] ?? "") ?? 0;
  const other = column(Object.entries(pins).find(([id]) => id !== pin)?.[1] ?? "") ?? 0;
  if (own !== other) return own < other ? "left leg" : "right leg";
  // Both legs in one column (a resistor across the channel, e15 and f15): upper and lower, by row letter.
  const row = (hole: HoleId | undefined) => {
    const parsed = hole ? parseHole(hole) : null;
    return parsed?.kind === "terminal" ? "abcdefghij".indexOf(parsed.column) : parsed?.kind === "rail" ? (parsed.rail.startsWith("T") ? -1 : 10) : 0;
  };
  const [mine, theirs] = [row(pins[pin]), row(Object.entries(pins).find(([id]) => id !== pin)?.[1])];
  return mine === theirs ? "leg" : mine < theirs ? "upper leg" : "lower leg";
}

/** Everything placed or wired before a step, with plain names. */
export function earlierItems(circuit: Circuit, layout: Layout, parts: string[], jumpers: string[], colors: Record<string, string>): Earlier[] {
  const items: Earlier[] = [];
  for (const partId of parts) {
    const placement = layout.placements.find((entry) => entry.part === partId);
    for (const [pin, hole] of Object.entries(placement?.pins ?? {})) {
      items.push({ ref: { part: partId, pin, hole }, label: `${partId}'s ${legName(circuit, layout, partId, pin)}` });
    }
  }
  for (const id of jumpers) {
    const jumper = layout.jumpers.find((entry) => entry.id === id);
    if (!jumper) continue;
    for (const end of [jumper.from, jumper.to]) {
      if ("hole" in end) items.push({ ref: { jumper: id, hole: end.hole }, label: `the ${wireColorName(colors[id] ?? jumper.color)} wire's end` });
    }
  }
  return items;
}

/** The farthest a "N columns left/right of …" landmark reaches. */
const NEAR_COLUMNS = 10;

/**
 * The best landmark for one new hole, or undefined: same strip (a part leg first, then a wire end), then the same
 * column across the channel, then the nearest earlier piece on the same side.
 */
export function holeLandmark(layout: Layout, hole: HoleId, earlier: Earlier[]): StepLandmark | undefined {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const group = contactGroup(profile, hole);
  const parsed = parseHole(hole);
  if (!group || parsed?.kind !== "terminal") return undefined;
  const legsFirst = [...earlier].sort((a, b) => Number("jumper" in a.ref) - Number("jumper" in b.ref));
  const strip = legsFirst.find((item) => item.ref.hole !== hole && contactGroup(profile, item.ref.hole) === group);
  if (strip) return { kind: "same-strip", hole, ref: strip.ref, text: `same strip as ${strip.label}` };
  const mine = column(hole)!;
  const across = legsFirst.find((item) => {
    const other = parseHole(item.ref.hole);
    return other?.kind === "terminal" && other.row === mine && side(item.ref.hole) !== side(hole);
  });
  if (across) return { kind: "across-channel", hole, ref: across.ref, text: `same column as ${across.label}, across the channel` };
  const sameSide = legsFirst.filter((item) => side(item.ref.hole) === side(hole) || parseHole(item.ref.hole)?.kind === "rail");
  const nearest = [...sameSide].sort((a, b) => Math.abs(column(a.ref.hole)! - mine) - Math.abs(column(b.ref.hole)! - mine))[0];
  // "45 columns left of the red wire's end" helps nobody find a hole: past a hand's width the hole name says it better.
  if (!nearest || Math.abs(mine - column(nearest.ref.hole)!) > NEAR_COLUMNS) return undefined;
  const columns = mine - column(nearest.ref.hole)!;
  if (columns === 0) return { kind: "near", hole, ref: nearest.ref, columns, text: `in line with ${nearest.label}` };
  const count = Math.abs(columns);
  return { kind: "near", hole, ref: nearest.ref, columns, text: `${count} column${count === 1 ? "" : "s"} ${columns > 0 ? "right" : "left"} of ${nearest.label}` };
}

/** "Arduino pin GND, between 5V and VIN": neighbours on the drawn header row (duplicates skipped). */
export function headerLandmark(layout: Layout, pin: string): StepLandmark | undefined {
  const row = boardHeaderRows(layout).find((pins) => pins.includes(pin));
  if (!row) return undefined;
  const index = row.indexOf(pin);
  const before = row.slice(0, index).reverse().find((name) => name !== pin);
  const after = row.slice(index + 1).find((name) => name !== pin);
  const neighbours = [before, after].filter((name): name is string => name !== undefined);
  if (neighbours.length === 0) return undefined;
  return { kind: "header", pin, neighbours, text: neighbours.length === 2 ? `between ${neighbours[0]} and ${neighbours[1]}` : `next to ${neighbours[0]}` };
}

/** Re-checks a landmark against the layout: the named strip, column, offset, or header neighbours really match. */
export function landmarkHolds(layout: Layout, landmark: StepLandmark): boolean {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  if (landmark.kind === "header") {
    const row = boardHeaderRows(layout).find((pins) => pins.includes(landmark.pin));
    if (!row) return false;
    const index = row.indexOf(landmark.pin);
    const around = [row.slice(0, index).reverse().find((name) => name !== landmark.pin), row.slice(index + 1).find((name) => name !== landmark.pin)].filter(Boolean);
    return landmark.neighbours.every((name) => around.includes(name));
  }
  const refHole = landmark.ref.hole;
  const refPresent = "part" in landmark.ref
    ? layout.placements.find((placement) => placement.part === (landmark.ref as { part: string }).part)?.pins[(landmark.ref as { pin: string }).pin] === refHole
    : layout.jumpers.some((jumper: Jumper) => jumper.id === (landmark.ref as { jumper: string }).jumper && [jumper.from, jumper.to].some((end) => "hole" in end && end.hole === refHole));
  if (!refPresent) return false;
  if (landmark.kind === "same-strip") return contactGroup(profile, landmark.hole) !== null && contactGroup(profile, landmark.hole) === contactGroup(profile, refHole);
  if (landmark.kind === "across-channel") return column(landmark.hole) === column(refHole) && side(landmark.hole) !== side(refHole) && parseHole(refHole)?.kind === "terminal";
  return landmark.kind === "near" && column(landmark.hole)! - column(refHole)! === landmark.columns;
}
