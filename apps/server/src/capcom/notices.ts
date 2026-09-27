import { CONSOLE_IDS, isPracticeRun, type BenchRunResult, type ConsoleReport, type Revision } from "@vibread/core";

/**
 * CAPCOM's unsolicited texts: short, plain, one idea each. Pure functions (unit-tested); index.ts decides who gets them,
 * when (quiet hours queue them) and how often (each notice is deduped by `key`).
 */

/** Findings that stop a design on a ViBread limit rather than a design mistake (plus any finding marked toolSide). */
const TOOL_STOP_RULES: Record<string, true> = { "LAYOUT-NO-FIT": true, "TESTS-SUSPECT": true };

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function orderedReports(reports: ConsoleReport[]): ConsoleReport[] {
  return CONSOLE_IDS.flatMap((id) => reports.filter((r) => r.console === id));
}

/** "Launch Control r2 is ready — EECOM GO · …", a NO-GO, or a tool-side stop; undefined while a console is still PENDING. */
export function designNotice(title: string, revision: Pick<Revision, "n" | "results">): { key: string; text: string } | undefined {
  const reports = orderedReports(revision.results.reports);
  if (reports.length === 0) return undefined;
  const name = `${title} r${revision.n}`;
  for (const report of reports) {
    const stop = report.findings.find((f) => f.severity === "error" && (f.toolSide === true || TOOL_STOP_RULES[f.ruleId] === true));
    if (stop) {
      return {
        key: `design:${revision.n}`,
        text: `${name} stopped on a ViBread limit (${stop.ruleId}): ${clip(stop.title, 160)}${stop.fix ? ` ${clip(stop.fix, 200)}` : ""}`,
      };
    }
  }
  const nogo = reports.find((r) => r.verdict === "NO-GO");
  if (nogo) return { key: `design:${revision.n}`, text: `${name}: NO-GO from ${nogo.console} — ${clip(nogo.summary, 180)}` };
  if (reports.some((r) => r.verdict === "PENDING")) return undefined;
  const line = reports.map((r) => `${r.console} ${r.verdict}`).join(" · ");
  return { key: `design:${revision.n}`, text: `${name} is ready — ${line}. Reply GO to start building.` };
}

/** Bench self-test finished (pass count), or a failed bench run's diagnosis and its top candidate. Virtual runs: none. */
export function benchNotice(title: string, result: Pick<BenchRunResult, "runId" | "kind" | "verdict" | "results" | "diagnosis">): { key: string; text: string } | undefined {
  if (isPracticeRun(result) || result.verdict === "incomplete") return undefined;
  const key = `bench:${result.runId}`;
  if (result.verdict === "pass") {
    if (result.kind !== "selftest") return undefined;
    const counted = result.results.filter((r) => r.status !== "skipped");
    const passed = counted.filter((r) => r.status === "pass").length;
    return { key, text: `${title}: bench self-test passed — ${passed}/${counted.length} checks.` };
  }
  const top = result.diagnosis.candidates[0];
  const summary = result.diagnosis.summary || `the bench ${result.kind === "selftest" ? "self-test" : result.kind} failed`;
  return { key, text: `${title}: ${faultAlertText(summary)}${top ? `\nMost likely: ${clip(top.title, 120)} — ${clip(top.fix, 200)}` : ""}` };
}

export function faultAlertText(summary: string): string {
  const normalized = summary.trim();
  if (/^Houston,\s+we have a problem\s*:/i.test(normalized)) return normalized;
  return `Houston, we have a problem: ${normalized}`;
}

/** Claude's question as text; the choices are numbered when no poll carries them (terminal, or poll send failed). */
export function questionText(title: string, question: string, choices: readonly string[], numbered: boolean): string {
  const list = numbered && choices.length ? `\n${choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n")}` : "";
  return `Claude has a question about ${title}: ${question}${list}`;
}

/** A reply to an open question: a choice number ("2") or a choice's text picks that choice; anything else is the answer. */
export function answerForChoice(choices: readonly string[], reply: string): string {
  const trimmed = reply.trim();
  const index = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  if (index >= 0 && index < choices.length) return choices[index]!;
  return choices.find((choice) => choice.trim().toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}

export function digestText(items: readonly { text: string }[]): string {
  return `While you were in quiet hours:\n${items.map((item) => `• ${item.text}`).join("\n")}`;
}
