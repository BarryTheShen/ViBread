import type { HoleId } from "./breadboards.js";
import type { TestId } from "./telemetry.js";

export const STEPS_SCHEMA = "vibread.steps/1" as const;

/**
 * Step order (PLAN §5.7): inventory → orientation legend → unplug → rails → plug in: rail checkpoint → unplug →
 * one part per step (polarity before insertion) → one jumper per step → plug in: subsection checkpoint → unplug →
 * … → final power-up. Every step states the USB plug state.
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
}

export interface StepList {
  schema: typeof STEPS_SCHEMA;
  layoutHash: string;
  steps: Step[];
}
