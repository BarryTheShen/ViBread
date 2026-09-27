import type { Circuit } from "@vibread/core";

/** Messages between the "Try it" tab and liveSim.worker.ts. */
export type LiveSimInput =
  | { type: "start"; circuit: Circuit; hex: string; light: Record<string, number>; analog: Record<string, number> }
  | { type: "digital"; part: string; value: boolean }
  | { type: "light"; part: string; level: number }
  | { type: "analog"; part: string; value: number }
  | { type: "serial"; text: string }
  | { type: "stop" };

export type LiveSimOutput =
  | { type: "started" }
  /** `tones`: what each buzzer is producing right now in Hz (0 = silent), for the speaker. */
  | { type: "state"; timeMs: number; parts: Record<string, number>; tones: Record<string, number> }
  | { type: "serial"; text: string }
  /** `stack`: where it was thrown in the worker, for the console and the error report (never shown in the banner). */
  | { type: "error"; message: string; stack?: string };
