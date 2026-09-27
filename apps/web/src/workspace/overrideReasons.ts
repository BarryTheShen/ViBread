import type { MissionDetail } from "@vibread/core";
import { CONSOLE_LABELS } from "@vibread/core";
import { releaseReadiness } from "./nextStep.js";

/** The release gate's refusal as the override dialog needs it (an `HttpError`'s code and message). */
export interface ReleaseGateError {
  code: string;
  message: string;
}

/** Server refusals the "Override — I know what I'm doing" dialog can bypass. */
export const OVERRIDE_CODES: Record<string, true> = { not_all_go: true, tests_missing: true, retro_no_go: true, retro_missing: true };

/**
 * The checks an override bypasses, one line each, for the override dialog. `error` is the server's last refusal; with
 * none (the override was opened from the "without the independent review?" confirm, before any refusal), a missing
 * review is what's being bypassed.
 */
export function overrideReasons(detail: MissionDetail, error: ReleaseGateError | undefined): string[] {
  const gate = error ?? (releaseReadiness(detail).retroMissing ? { code: "retro_missing", message: "The independent review hasn't voted GO yet." } : undefined);
  const reasons: string[] = [];
  if (gate?.code === "tests_missing") reasons.push("Simulation tests (FIDO) not written");
  const serverFidoDetails = (gate?.message.match(/(?:failed scenarios|set-aside tests \(warnings only\)):[^.;]+/g) ?? []).join("; ");
  for (const report of detail.consoles) {
    if (report.verdict === "GO") continue;
    const ids = (ruleId?: string) => [...new Set(report.findings.filter((finding) => (ruleId ? finding.ruleId === ruleId : finding.severity === "error")).flatMap((finding) => finding.refs?.scenarios ?? []))];
    const failing = ids();
    const setAside = ids("TEST-SET-ASIDE");
    const found = [...(failing.length > 0 ? [`failing scenarios: ${failing.join(", ")}`] : []), ...(setAside.length > 0 ? [`set-aside tests (warnings only): ${setAside.join(", ")}`] : [])].join("; ");
    const details = found || (report.console === "FIDO" ? serverFidoDetails : "");
    const suffix = report.console === "FIDO" && details ? ` — ${details}` : "";
    if (report.console === "FIDO" && gate?.code === "tests_missing") continue;
    reasons.push(`${CONSOLE_LABELS[report.console]} (${report.console}) ${report.verdict}${suffix}`);
  }
  const retro = detail.consoles.find((report) => report.console === "RETRO");
  const retroListed = reasons.some((reason) => reason.startsWith(`${CONSOLE_LABELS.RETRO} (RETRO)`));
  if (gate?.code === "retro_missing" && retro?.verdict !== "GO" && !retroListed) reasons.push(`${CONSOLE_LABELS.RETRO} (RETRO) not run`);
  if (gate?.code === "retro_no_go" && retro?.verdict === "NO-GO" && !retroListed) {
    reasons.push(`${CONSOLE_LABELS.RETRO} (RETRO) NO-GO${retro.summary ? ` — ${retro.summary}` : ""}`);
  }
  return reasons.length > 0 ? reasons : [gate?.message ?? "The release safety gate refused this revision."];
}
