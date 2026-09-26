import type { BoardProfileId } from "./boards.js";
import type { TestId } from "./telemetry.js";

export const SELFTEST_SCHEMA = "vibread.selftest/1" as const;

/** Hard safety limits for anything the bench firmware drives (PLAN §5.9). */
export const SELFTEST_LIMITS = { ledOnMsMax: 5, dutyMax: 0.1, probeMicrosMax: 4 } as const;

/** One thing on the breadboard the self-test can observe. Derived from the IR by @vibread/bench `planSelfTest`. */
export type SelfTestSubject =
  | { kind: "led"; part: string; pin: string; label: string; activeHigh: boolean; /** 1 = leftmost in the row, for "which LED" answers */ order: number }
  | { kind: "button"; part: string; pin: string; label: string; pressedLevel: 0 | 1; pull: "internal-up" | "external" }
  | { kind: "light"; part: string; pin: string; label: string; brighterReadsHigher: boolean }
  | { kind: "pot"; part: string; pin: string; label: string }
  | { kind: "buzzer"; part: string; pin: string; label: string; active: boolean }
  | { kind: "digital-in"; part: string; pin: string; label: string }
  | { kind: "analog-in"; part: string; pin: string; label: string };

export interface SelfTestPlan {
  schema: typeof SELFTEST_SCHEMA;
  /** shortHash of the revision; printed in the firmware `hello` banner. */
  design: string;
  board: BoardProfileId;
  subjects: SelfTestSubject[];
  /** Run order for {c:"run",test:"all"}; always starts with rails.vcc, pins.readonly. */
  tests: TestId[];
  timing: {
    ledOnMs: number;
    ledPeriodMs: number;
    /** Pulses per LED before asking which one blinked. */
    ledPulses: number;
    promptTimeoutMs: number;
    /** Samples per digital read / ADC statistic. */
    samples: number;
  };
}
