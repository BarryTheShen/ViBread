/** Standard breadboard profiles (issue #23). IDs are stored in circuits and missions: never rename or remove one. */
export const BREADBOARD_PROFILE_IDS = ["bb-830", "bb-400", "bb-170", "bb-830-split"] as const;
export type BreadboardProfileId = (typeof BREADBOARD_PROFILE_IDS)[number];

export const COLUMNS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;
export type Column = (typeof COLUMNS)[number];

/**
 * Rails: T = top edge (next to column a), B = bottom edge (next to column j).
 * Drawing order from the outside in: T- (blue), T+ (red), [a..e], channel, [f..j], B+ (red), B- (blue).
 */
export const RAILS = ["T+", "T-", "B+", "B-"] as const;
export type RailId = (typeof RAILS)[number];

export const RAIL_SIDES = ["top", "bottom"] as const;
export type RailSide = (typeof RAIL_SIDES)[number];

/**
 * Hole id grammar (the contract every package uses):
 *   terminal hole  "<column><row>"   e.g. "a1", "e12", "j63"   (row 1..rows)
 *   rail hole      "<rail><position>" e.g. "T+12", "B-3"      (position = the row number the rail hole lines up with)
 * A hole id is the label printed on the board, so the printed-label facts below never change hole ids or connectivity.
 */
export type HoleId = string;

/**
 * What is printed on the board, relative to the drawing orientation (long side horizontal, the T rails' edge on top).
 * Drawings and step text use these; they never change which holes are connected.
 */
export interface BreadboardLabels {
  /** End where row 1 is printed; numbers count up from there. */
  rowOne: "left" | "right";
  /** Long edge next to column a (a–e on that side of the channel, f–j on the other). */
  columnA: "top" | "bottom";
  /** In each rail pair: the red + line on the board edge ("outside") or next to the terminal strips ("inside"). */
  redRail: "outside" | "inside";
}

export interface BreadboardProfile {
  id: BreadboardProfileId;
  name: string;
  /** Step wording: "your 400-point board". */
  shortName: string;
  /** Tie points printed on the packaging (170, 400, 830). */
  points: number;
  rows: number;
  /** Edges that carry a +/− rail pair; empty on a mini board (power then goes through terminal strips). */
  railSides: RailSide[];
  /** Row numbers where rail holes exist (groups of 5 with a one-hole gap); empty when there are no rails. */
  railPositions: number[];
  /** When true each rail is split into two halves at `railSplitAfter`; a bridge wire joins them (`railBridge`). */
  railsSplit: boolean;
  railSplitAfter?: number;
  labels: BreadboardLabels;
  /** One sentence telling the vision model how this board looks in a photo. */
  photoHint: string;
  /** How a person tells it apart from the other profiles (shown in the picker and the photo result). */
  identify: string[];
  pitchMm: 2.54;
}

function railGroups(groups: number): number[] {
  const out: number[] = [];
  for (let g = 0; g < groups; g++) for (let k = 0; k < 5; k++) out.push(2 + g * 6 + k);
  return out;
}

const PRINTED_DEFAULT: BreadboardLabels = { rowOne: "left", columnA: "top", redRail: "inside" };

export const BREADBOARD_PROFILES: Record<BreadboardProfileId, BreadboardProfile> = {
  "bb-830": {
    id: "bb-830",
    name: "Full-size breadboard (830 points, 63 rows)",
    shortName: "830-point board",
    points: 830,
    rows: 63,
    railSides: ["top", "bottom"],
    railPositions: railGroups(10),
    railsSplit: false,
    labels: PRINTED_DEFAULT,
    photoHint: "A long white board with 63 numbered rows, a centre channel, and an unbroken red/blue rail line along both long edges.",
    identify: ["holes numbered 1–63", "rail lines run the full length without a break", "about 16.5 cm long"],
    pitchMm: 2.54,
  },
  "bb-400": {
    id: "bb-400",
    name: "Half-size breadboard (400 points, 30 rows)",
    shortName: "400-point board",
    points: 400,
    rows: 30,
    railSides: ["top", "bottom"],
    railPositions: railGroups(5),
    railsSplit: false,
    labels: PRINTED_DEFAULT,
    photoHint: "A white board about the size of a phone with 30 numbered rows, a centre channel, and red/blue rails along both long edges.",
    identify: ["holes numbered 1–30", "red and blue rails on both long edges", "about 8.3 cm long"],
    pitchMm: 2.54,
  },
  "bb-170": {
    id: "bb-170",
    name: "Mini breadboard (170 points, 17 rows, no rails)",
    shortName: "170-point mini board",
    points: 170,
    rows: 17,
    railSides: [],
    railPositions: [],
    railsSplit: false,
    labels: PRINTED_DEFAULT,
    photoHint: "A small square-ish board (often coloured) with 17 rows of 10 holes split by a centre channel and no red/blue rails at all.",
    identify: ["holes numbered only 1–17", "no red or blue power rails", "about 4.5 cm long"],
    pitchMm: 2.54,
  },
  "bb-830-split": {
    id: "bb-830-split",
    name: "Full-size breadboard with split rails (830 points, 63 rows)",
    shortName: "830-point board (split rails)",
    points: 830,
    rows: 63,
    railSides: ["top", "bottom"],
    railPositions: railGroups(10),
    railsSplit: true,
    railSplitAfter: 31,
    labels: PRINTED_DEFAULT,
    photoHint: "A long white board with 63 numbered rows whose red/blue rail lines stop in the middle, leaving a visible gap between two rail halves.",
    identify: ["holes numbered 1–63", "the red and blue rail lines break in the middle", "a wider gap between rail hole groups at the centre"],
    pitchMm: 2.54,
  },
};

export function isBreadboardProfileId(value: unknown): value is BreadboardProfileId {
  return typeof value === "string" && (BREADBOARD_PROFILE_IDS as readonly string[]).includes(value);
}

export type ParsedHole =
  | { kind: "terminal"; column: Column; row: number }
  | { kind: "rail"; rail: RailId; position: number };

const HOLE_RE = /^(?:([a-j])(\d{1,2})|([TB][+-])(\d{1,2}))$/;

export function parseHole(id: HoleId): ParsedHole | null {
  const m = HOLE_RE.exec(id);
  if (!m) return null;
  if (m[1]) return { kind: "terminal", column: m[1] as Column, row: Number(m[2]) };
  return { kind: "rail", rail: m[3] as RailId, position: Number(m[4]) };
}

export function isValidHole(profile: BreadboardProfile, id: HoleId): boolean {
  const h = parseHole(id);
  if (!h) return false;
  if (h.kind === "terminal") return h.row >= 1 && h.row <= profile.rows;
  return profile.railSides.includes(h.rail.startsWith("T") ? "top" : "bottom") && profile.railPositions.includes(h.position);
}

/**
 * Electrical contact group of a hole: holes with the same group id are connected by the breadboard itself.
 *   terminal a–e of row r → "r<r>:a-e", f–j of row r → "r<r>:f-j"; rails → "T+", "B-" (or "T+:1"/"T+:2" when split).
 */
export function contactGroup(profile: BreadboardProfile, id: HoleId): string | null {
  const h = parseHole(id);
  if (!h || !isValidHole(profile, id)) return null;
  if (h.kind === "terminal") return `r${h.row}:${"abcde".includes(h.column) ? "a-e" : "f-j"}`;
  if (!profile.railsSplit || profile.railSplitAfter === undefined) return h.rail;
  return `${h.rail}:${h.position <= profile.railSplitAfter ? 1 : 2}`;
}

/** The +/− rails the allocator powers the build from (the top pair when there is one); null on a board without rails. */
export function powerRails(profile: BreadboardProfile): { plus: RailId; minus: RailId } | null {
  if (profile.railSides.includes("top")) return { plus: "T+", minus: "T-" };
  if (profile.railSides.includes("bottom")) return { plus: "B+", minus: "B-" };
  return null;
}

/**
 * Split rails: the two holes a bridge wire joins across the gap (last hole of the first half, first hole of the
 * second), e.g. ["T+30", "T+32"]. Null when the rail is not split or not on this board.
 */
export function railBridge(profile: BreadboardProfile, rail: RailId): [HoleId, HoleId] | null {
  if (!profile.railsSplit || profile.railSplitAfter === undefined || !profile.railSides.includes(rail.startsWith("T") ? "top" : "bottom")) return null;
  const split = profile.railSplitAfter;
  const before = profile.railPositions.filter((position) => position <= split).at(-1);
  const after = profile.railPositions.find((position) => position > split);
  if (before === undefined || after === undefined) return null;
  return [`${rail}${before}`, `${rail}${after}`];
}

/** True for a wire joining the two halves of one split rail (the builder adds it with the rails, before any part). */
export function isRailBridge(profile: BreadboardProfile, jumper: { from: { hole: HoleId } | { board: string }; to: { hole: HoleId } | { board: string } }): boolean {
  if (!("hole" in jumper.from) || !("hole" in jumper.to)) return false;
  const a = parseHole(jumper.from.hole);
  const b = parseHole(jumper.to.hole);
  if (a?.kind !== "rail" || b?.kind !== "rail" || a.rail !== b.rail) return false;
  const ga = contactGroup(profile, jumper.from.hole);
  const gb = contactGroup(profile, jumper.to.hole);
  return ga !== null && gb !== null && ga !== gb;
}
