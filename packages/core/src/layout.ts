import type { BoardPinName, BoardProfileId } from "./boards.js";
import type { BreadboardProfileId, Column, HoleId } from "./breadboards.js";
import type { PinRef } from "./circuit.js";

export const LAYOUT_SCHEMA = "vibread.layout/1" as const;

/** A jumper end: a breadboard hole, or an Arduino header pin (Uno sits off-board). */
export type Endpoint = { hole: HoleId } | { board: BoardPinName };

export interface Placement {
  part: string;
  /** Part pin id → hole. Every pin of the part is placed. */
  pins: Record<string, HoleId>;
}

export const WIRE_COLORS = ["red", "black", "yellow", "green", "blue", "orange", "white", "purple", "brown", "gray"] as const;
export type WireColor = (typeof WIRE_COLORS)[number];

/** Colours found in ordinary jumper-wire kits: the builder's picker swatches (a custom #rrggbb is also allowed). */
export const KIT_WIRE_COLORS = ["red", "black", "orange", "yellow", "green", "blue", "purple", "white", "brown", "gray"] as const;
export type KitWireColor = (typeof KIT_WIRE_COLORS)[number];

/** Screen colour of each kit wire colour (breadboard drawings, schematic, picker). */
export const KIT_WIRE_CSS: Record<KitWireColor, string> = {
  red: "#e5484d",
  black: "#202a31",
  orange: "#f08c2e",
  yellow: "#f2c94c",
  green: "#2fbf71",
  blue: "#3d8bfd",
  purple: "#9b6bdb",
  white: "#f4f6f8",
  brown: "#986b4f",
  gray: "#8a939c",
};

/** A kit colour name or a custom "#rrggbb". */
export function isWireColorValue(value: unknown): value is string {
  return typeof value === "string" && ((KIT_WIRE_COLORS as readonly string[]).includes(value) || /^#[0-9a-f]{6}$/i.test(value));
}

/** CSS colour for a kit name or custom #rrggbb. */
export function wireCss(value: string): string {
  return (KIT_WIRE_CSS as Record<string, string>)[value] ?? (/^#[0-9a-f]{6}$/i.test(value) ? value : KIT_WIRE_CSS.white);
}

export interface Jumper {
  /** W1, W2 … in build order. */
  id: string;
  from: Endpoint;
  to: Endpoint;
  /** Convention: red = 5 V, black = GND, other colors for signals (never color alone in the UI). */
  color: WireColor;
  /** IR net this jumper belongs to. */
  net: string;
}

export interface Layout {
  schema: typeof LAYOUT_SCHEMA;
  board: BoardProfileId;
  breadboard: BreadboardProfileId;
  placements: Placement[];
  jumpers: Jumper[];
  /** Nano only: the board straddles the channel with pin 1 at `topRow` in `columns[0]`. */
  boardAnchor?: { topRow: number; columns: [Column, Column] };
}

export type LvsIssueKind =
  | "split-net"
  | "merged-nets"
  | "power-short"
  | "floating-pin"
  | "duplicate-hole"
  | "invalid-hole"
  | "unplaced-part"
  | "missing-connection";

export interface LvsIssue {
  kind: LvsIssueKind;
  severity: "error" | "warning";
  message: string;
  nets?: string[];
  pins?: string[];
  holes?: HoleId[];
}

export interface DerivedNet {
  /** Deterministic id: "dn-<n>" in first-seen order. */
  id: string;
  members: PinRef[];
  holes: HoleId[];
}

export interface LvsResult {
  ok: boolean;
  derivedNets: DerivedNet[];
  issues: LvsIssue[];
  /** IR net id → derived net id (when the IR net maps onto exactly one derived net). */
  netMap: Record<string, string>;
}

/**
 * Where each part ended up and whether each requested placement group is side by side (issue #16). The design agent
 * describes the layout from this, never from its own intentions.
 */
export interface PlacementSummary {
  /** `rows`: breadboard row numbers (1…63), which run left to right in every drawing; `side`: half of the board. */
  parts: { part: string; rows: [number, number]; side: "a-e" | "f-j" | "both" }[];
  groups: { parts: string[]; met: boolean; detail: string }[];
  /** Plain-language summary for the agent and the person. */
  text: string;
}
