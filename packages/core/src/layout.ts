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

export const WIRE_COLORS = ["red", "black", "yellow", "green", "blue", "orange", "white", "purple"] as const;
export type WireColor = (typeof WIRE_COLORS)[number];

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
