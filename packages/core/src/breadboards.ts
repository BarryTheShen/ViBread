export const BREADBOARD_PROFILE_IDS = ["bb-830", "bb-400"] as const;
export type BreadboardProfileId = (typeof BREADBOARD_PROFILE_IDS)[number];

export const COLUMNS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;
export type Column = (typeof COLUMNS)[number];

/**
 * Rails: T = top edge (next to column a), B = bottom edge (next to column j).
 * Drawing order from the outside in: T- (blue), T+ (red), [a..e], channel, [f..j], B+ (red), B- (blue).
 */
export const RAILS = ["T+", "T-", "B+", "B-"] as const;
export type RailId = (typeof RAILS)[number];

/**
 * Hole id grammar (the contract every package uses):
 *   terminal hole  "<column><row>"   e.g. "a1", "e12", "j63"   (row 1..rows)
 *   rail hole      "<rail><position>" e.g. "T+12", "B-3"      (position = the row number the rail hole lines up with)
 */
export type HoleId = string;

export interface BreadboardProfile {
  id: BreadboardProfileId;
  name: string;
  rows: number;
  /** Row numbers where rail holes exist (groups of 5 with a one-hole gap). */
  railPositions: number[];
  /** When true each rail is split into two halves at `railSplitAfter` (common on 830-point boards). */
  railsSplit: boolean;
  railSplitAfter?: number;
  pitchMm: 2.54;
}

function railGroups(groups: number): number[] {
  const out: number[] = [];
  for (let g = 0; g < groups; g++) for (let k = 0; k < 5; k++) out.push(2 + g * 6 + k);
  return out;
}

export const BREADBOARD_PROFILES: Record<BreadboardProfileId, BreadboardProfile> = {
  "bb-830": { id: "bb-830", name: "Full-size breadboard (830 points, 63 rows)", rows: 63, railPositions: railGroups(10), railsSplit: false, pitchMm: 2.54 },
  "bb-400": { id: "bb-400", name: "Half-size breadboard (400 points, 30 rows)", rows: 30, railPositions: railGroups(5), railsSplit: false, pitchMm: 2.54 },
};

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
  return profile.railPositions.includes(h.position);
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
