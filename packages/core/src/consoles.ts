import type { HoleId } from "./breadboards.js";

/** Go/No-Go consoles (PLAN §2, §5.4). UI shows the plain label first; the console name is flavor. */
export const CONSOLE_IDS = ["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"] as const;
export type ConsoleId = (typeof CONSOLE_IDS)[number];

export const CONSOLE_LABELS: Record<ConsoleId, string> = {
  EECOM: "Electrical checks",
  GUIDO: "Firmware",
  FIDO: "Simulation tests",
  FAO: "Assembly",
  RETRO: "Independent review",
};

export interface FindingRefs {
  parts?: string[];
  nets?: string[];
  pins?: string[];
  holes?: HoleId[];
  steps?: number[];
  scenarios?: string[];
}

export interface Finding {
  console: ConsoleId;
  /** Stable rule id, e.g. "LED-RESISTOR", "CUR-PIN-DESIGN", "LVS-SPLIT-NET", "COV-OUTPUT". */
  ruleId: string;
  severity: "error" | "warning" | "info";
  /** Plain-language one-liner for a beginner. */
  title: string;
  /** Technical detail (numbers, corners, compiler text). */
  detail?: string;
  /** What to change. */
  fix?: string;
  refs?: FindingRefs;
}

export type Verdict = "GO" | "NO-GO" | "PENDING" | "SKIPPED";

export interface ConsoleReport {
  console: ConsoleId;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  /** Console-specific numbers (currents, sizes, pass counts) for the details panel. */
  evidence?: Record<string, unknown>;
  revisionHash: string;
  at: string;
}

/** The GO rule shared by every console: any error-severity finding is NO-GO. */
export function verdictOf(findings: Finding[]): Verdict {
  return findings.some((f) => f.severity === "error") ? "NO-GO" : "GO";
}
