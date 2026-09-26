import type { HoleId } from "./breadboards.js";
import type { PinMode } from "./circuit.js";
import type { ConsoleReport } from "./consoles.js";
import type { ScenarioStep } from "./scenario.js";
import type { TestId } from "./telemetry.js";

// ---------- firmware (@vibread/firmware) ----------

export interface CompileDiagnostic {
  severity: "error" | "warning" | "note";
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  fqbn: string;
  /** Intel HEX text of the application image (absent when !ok). */
  hex?: string;
  sizes?: { flashBytes: number; flashMax: number; ramBytes: number; ramMax: number };
  diagnostics: CompileDiagnostic[];
  durationMs: number;
  /** Raw compiler output, truncated to ~8 kB, for the details panel. */
  log: string;
}

// ---------- simulation (@vibread/sim) ----------

/** Pin configuration the sketch actually produced in simulation (decoded from DDRx/PORTx and timer registers). */
export interface PinModeObservation {
  pin: string;
  mode: PinMode | "UNUSED";
  /** Pin changed level at least once as an output. */
  toggled: boolean;
  /** First virtual ms at which the mode was set. */
  firstMs?: number;
}

export interface StepResult {
  index: number;
  step: ScenarioStep;
  ok: boolean;
  message: string;
  atMs: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  clauses: string[];
  ok: boolean;
  steps: StepResult[];
  /** Virtual duration. */
  durationMs: number;
  serial: string;
  /** Artifact key of the recorded trace (see Trace). */
  traceKey?: string;
}

/** Sampled part states for the replay on the breadboard view: every ≤ 20 ms of virtual time or on change. */
export interface TraceFrame {
  t: number;
  /** LED brightness 0..1, buzzer 0/1, button 0/1 (pressed), light level, pot position. */
  parts: Record<string, number>;
  /** Board pin output levels (only pins configured as OUTPUT). */
  pins: Record<string, 0 | 1>;
}

export interface Trace {
  scenario: string;
  frames: TraceFrame[];
}

export interface Coverage {
  ok: boolean;
  outputsAsserted: Record<string, boolean>;
  inputsExercised: Record<string, boolean>;
  clausesCovered: Record<string, string[]>;
  categoriesPresent: string[];
  categoriesRequired: string[];
  /** Human-readable gaps, e.g. "LED3 is never checked", "no bounce test for BTN1". */
  missing: string[];
}

export interface SimRunResult {
  scenarios: ScenarioResult[];
  coverage: Coverage;
  pinModes: PinModeObservation[];
  traces: Trace[];
  /** FIDO console report (tests pass AND coverage holds). */
  report: ConsoleReport;
  /** Virtual ms simulated per wall-clock ms. */
  speed: number;
}

// ---------- bench (@vibread/bench) ----------

export interface SubjectResult {
  part: string;
  pin: string;
  status: "pass" | "fail" | "unknown" | "skipped";
  observed: string;
  expected: string;
}

export interface BenchTestResult {
  test: TestId;
  status: "pass" | "fail" | "unknown" | "skipped";
  subjects: SubjectResult[];
  summary: string;
}

export type Attribution = "design" | "code" | "wiring" | "component" | "unknown" | "none";

export interface DiagnosisCandidate {
  /** Rule-table cause id, e.g. "button-leg-in-gnd-row", "led-jumpers-swapped", "divider-resistor-missing". */
  cause: string;
  title: string;
  /** 0..1, ranked descending. */
  likelihood: number;
  highlight: { holes: HoleId[]; parts: string[]; jumpers: string[] };
  fix: string;
}

export interface Diagnosis {
  attribution: Attribution;
  candidates: DiagnosisCandidate[];
  /** "Houston, we have a problem: D2 reads LOW even with the button released — its leg shares row 17 with the GND jumper." */
  summary: string;
}

/** Light-sensor calibration → sketch macros (VB_CAL_<PART>_DARK / _HYST). */
export interface Calibration {
  part: string;
  ambient: number;
  covered: number;
  threshold: number;
  hysteresis: number;
  macros: Record<string, number>;
}

export interface BenchRunResult {
  runId: string;
  revision: number;
  kind: "rails" | "checkpoint" | "selftest";
  results: BenchTestResult[];
  diagnosis: Diagnosis;
  calibration: Calibration[];
  verdict: "pass" | "fail" | "incomplete";
}

// ---------- photo check ----------

export interface PhotoPartAnswer {
  part: string;
  status: "correct" | "wrong" | "missing" | "unknown";
  note: string;
}

export interface PhotoCheckResult {
  step: number;
  answers: PhotoPartAnswer[];
  summary: string;
  /** Always advisory: never blocks progress, never overrides telemetry. */
  advisory: true;
  model: string;
  /**
   * Set when Claude isn't connected: the user's photo was NOT analyzed (`answers` is empty) and this is a recorded example
   * of what a photo check looks like, shown only as such.
   */
  recordedExample?: RecordedPhotoExample;
}

/** A real Claude photo-check answer captured earlier, shown when no credential exists (PLAN §4 named fallback). */
export interface RecordedPhotoExample {
  /** Chip text, e.g. "Recorded example · Claude Sonnet 5 · Sep 26". */
  label: string;
  /** Plain explanation of what this is and what it is not. */
  note: string;
  model: string;
  recordedAt: string;
  /** Design and build step the example is about (not necessarily the user's). */
  design: string;
  step: number;
  stepTitle: string;
  /** URL of the picture Claude was shown for that step. */
  imageUrl: string;
  /** True when no real photo existed and Claude was shown ViBread's drawing instead. */
  photoWasRender: boolean;
  answers: PhotoPartAnswer[];
  summary: string;
}
