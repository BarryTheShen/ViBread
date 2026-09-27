import type { HoleId } from "./breadboards.js";
import type { TestId } from "./telemetry.js";

export const STEPS_SCHEMA = "vibread.steps/1" as const;

/**
 * Step order (PLAN §5.7): inventory → orientation legend → unplug → rails → plug in: rail checkpoint → unplug →
 * repeated units (one copy, then "repeat ×N") → one part per step (polarity before insertion) → one jumper per step →
 * plug in: subsection checkpoint → unplug → … → final power-up. Every step states the USB plug state.
 */
export type StepKind = "inventory" | "orientation" | "unplug" | "rails" | "checkpoint" | "place" | "jumper" | "power-up";

export interface Step {
  /** 1-based. */
  n: number;
  kind: StepKind;
  /** "Place R1 (220 Ω)". */
  title: string;
  /** Exact holes in words, never color alone: "Put R1 from e12 to e16. Bands: red-red-brown-gold." */
  text: string;
  /** USB cable state during this step. */
  plug: "unplugged" | "plugged";
  /** Items new in this step (highlighted and animated in the step image). */
  adds: { parts: string[]; jumpers: string[] };
  holes: HoleId[];
  /** Parts callout: "1× 220 Ω resistor — red-red-brown-gold". */
  callouts: string[];
  /** Plugged-in checkpoints run these self-tests. */
  checkpoint?: { tests: TestId[]; text: string };
  /** Where the new pieces go relative to what is already built (computed from the layout, issue #22). */
  landmarks?: StepLandmark[];
  /** Both ends of each wire this step adds, as badged "1" and "2" in the step picture. */
  wireEnds?: { jumper: string; ends: [WireEnd, WireEnd] }[];
  /**
   * Repeated units (issue #25). On the step that builds the first copy: `role: "template"`. On the step right after it
   * that builds all the other copies at once: `role: "repeat"`, with a per-copy checklist. Both carry every copy, so
   * the picture can show the ×N badge and ghosted copies.
   */
  repeat?: StepRepeat;
}

export interface StepRepeat {
  role: "template" | "repeat";
  /** Step number of the template step. */
  template: number;
  /** Copies in all, the template's included. */
  count: number;
  /** Numbered columns from one copy to the next (to the right). */
  columns: number;
  /** Every copy, left to right; copy 1 is the template's. */
  copies: RepeatCopy[];
}

export interface RepeatCopy {
  /** 1-based, left to right. */
  index: number;
  parts: string[];
  jumpers: string[];
  /** Arduino pins this copy is wired to ("D6"). */
  boardPins: string[];
  /** Leftmost numbered column the copy uses. */
  column: number;
  holes: HoleId[];
  /** One checklist line: "Copy 2 → D6: LED4 in a38 and T-38, R4 in f38 and e38, wire from D6 to j38." */
  text: string;
}

/** An earlier piece a landmark points at: one leg of a placed part, or one end of an earlier wire. */
export type LandmarkRef = { part: string; pin: string; hole: HoleId } | { jumper: string; hole: HoleId };

/**
 * A true statement about where a new leg or wire end goes. `hole` is the new hole; for `near`, `columns` is its
 * numbered-column offset from the reference (positive = to the right). `header` is an Arduino pin and its neighbours.
 */
export type StepLandmark =
  | { kind: "same-strip" | "across-channel"; hole: HoleId; ref: LandmarkRef; text: string }
  | { kind: "near"; hole: HoleId; ref: LandmarkRef; columns: number; text: string }
  | { kind: "header"; pin: string; neighbours: string[]; text: string };

export interface WireEnd {
  n: 1 | 2;
  /** A breadboard hole ("j16", "T-24") or an Arduino pin ("board:D2"). */
  at: string;
  /** "hole j16", "Arduino pin D2". */
  text: string;
}

export interface StepList {
  schema: typeof STEPS_SCHEMA;
  layoutHash: string;
  steps: Step[];
}
