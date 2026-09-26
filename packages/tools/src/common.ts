import {
  CONSOLE_IDS,
  verdictOf,
  type Actor,
  type Circuit,
  type ConsoleId,
  type ConsoleReport,
  type Finding,
  type MissionStore,
  type Revision,
  type ToolDef,
} from "@vibread/core";

/** Physical actions the bench browser runs after a human click (the broker's `action` for request_bench_action). */
export const BENCH_ACTIONS = ["flash-bench", "rail-checkpoint", "run-selftest", "flash-app"] as const;
export type BenchAction = (typeof BENCH_ACTIONS)[number];
export const BENCH_ACTION_TEXT: Record<BenchAction, string> = {
  "flash-bench": "Put ViBread's safe self-test firmware on the board",
  "rail-checkpoint": "Run the power-rail checkpoint",
  "run-selftest": "Run the full self-test of the breadboard",
  "flash-app": "Flash your project's sketch to the board",
};

export const SYSTEM_ACTOR: Actor = { kind: "system", id: "pipeline", name: "ViBread checks", channel: "system" };

/** Thrown when an agent call needs Claude and no ANTHROPIC_API_KEY is configured. Shown to the user verbatim. */
export class ClaudeNotConnectedError extends Error {
  readonly code = "claude_not_connected";
  readonly status = 503;
  constructor(message = "Claude is not connected: connect your Claude account in Settings, or set ANTHROPIC_API_KEY on the server.") {
    super(message);
    this.name = "ClaudeNotConnectedError";
  }
}

/** A tool refused the request (bad revision, missing data); the message is written for the agent and the user. */
export class ToolInputError extends Error {
  readonly code: string;
  /** HTTP status for REST callers: 400 bad input, 404 missing mission/revision. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.code = status === 404 ? "not_found" : "tool_input";
    this.name = "ToolInputError";
  }
}

export function isClaudeNotConnected(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "claude_not_connected";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ToolDef<I, O> → ToolDef: handlers are contravariant in their input, so the registry stores them erased. */
export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef {
  return def as unknown as ToolDef;
}

export async function requireRevision(store: MissionStore, missionId: string, n?: number): Promise<Revision> {
  const revision = await store.getRevision(missionId, n);
  if (!revision) {
    throw new ToolInputError(n === undefined ? "This mission has no design yet — propose one first." : `Revision ${n} does not exist.`);
  }
  return revision;
}

export function artifactUrl(missionId: string, n: number, key: string): string {
  return `/api/missions/${encodeURIComponent(missionId)}/revisions/${n}/artifacts/${encodeURIComponent(key)}`;
}

export function report(console: ConsoleId, findings: Finding[], summary: string, revisionHash: string, evidence?: Record<string, unknown>): ConsoleReport {
  return { console, verdict: verdictOf(findings), summary, findings, revisionHash, at: new Date().toISOString(), ...(evidence ? { evidence } : {}) };
}

export function statusReport(console: ConsoleId, verdict: "PENDING" | "SKIPPED", summary: string, revisionHash: string): ConsoleReport {
  return { console, verdict, summary, findings: [], revisionHash, at: new Date().toISOString() };
}

/** Adds findings to a report and re-derives its verdict (PENDING/SKIPPED become GO/NO-GO only through errors). */
export function withFindings(base: ConsoleReport, extra: Finding[], evidence?: Record<string, unknown>): ConsoleReport {
  if (!extra.length && !evidence) return base;
  const findings = [...base.findings, ...extra];
  const hasError = extra.some((f) => f.severity === "error");
  const verdict = base.verdict === "PENDING" || base.verdict === "SKIPPED" ? (hasError ? "NO-GO" : base.verdict) : verdictOf(findings);
  return { ...base, findings, verdict, evidence: { ...base.evidence, ...evidence } };
}

export function crashFinding(console: ConsoleId, stage: string, error: unknown, severity: Finding["severity"] = "error"): Finding {
  return {
    console,
    ruleId: "STAGE-CRASH",
    severity,
    title: `The ${stage} step crashed, so this check could not finish.`,
    detail: errorMessage(error),
    fix: "This is a ViBread problem, not your circuit. Try again; if it repeats, report it.",
  };
}

export function verdicts(reports: ConsoleReport[]): Partial<Record<ConsoleId, ConsoleReport["verdict"]>> {
  const out: Partial<Record<ConsoleId, ConsoleReport["verdict"]>> = {};
  for (const r of reports) out[r.console] = r.verdict;
  return out;
}

/** Every console including RETRO is GO (PLAN §5.10 `allGo`). */
export function allGo(reports: ConsoleReport[]): boolean {
  return CONSOLE_IDS.every((id) => reports.find((r) => r.console === id)?.verdict === "GO");
}

export const DETERMINISTIC_CONSOLES: ConsoleId[] = ["EECOM", "GUIDO", "FIDO", "FAO"];

export function deterministicGo(reports: ConsoleReport[]): boolean {
  return DETERMINISTIC_CONSOLES.every((id) => reports.find((r) => r.console === id)?.verdict === "GO");
}

/**
 * What the independent test author may see (PLAN §5.2): brief-level interface of the design — parts, pin roles, intent —
 * never the sketch and never the nets. Built field by field so new IR fields don't leak by accident.
 */
export interface CircuitInterface {
  title: string;
  summary: string;
  board: Circuit["board"];
  parts: { id: string; module: string; label?: string; params: Record<string, unknown> }[];
  roles: Circuit["roles"];
  intent: Circuit["intent"];
  assumptions: string[];
}

export function circuitInterface(circuit: Circuit): CircuitInterface {
  return {
    title: circuit.title,
    summary: circuit.summary,
    board: { profile: circuit.board.profile },
    parts: circuit.parts.map((p) => ({ id: p.id, module: p.module, ...(p.label ? { label: p.label } : {}), params: { ...p.params } })),
    roles: circuit.roles.map((r) => ({ pin: r.pin, mode: r.mode, part: r.part, purpose: r.purpose })),
    intent: circuit.intent.map((c) => ({ id: c.id, text: c.text })),
    assumptions: [...circuit.assumptions],
  };
}
