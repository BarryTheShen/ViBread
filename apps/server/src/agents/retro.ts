import { verdictOf, type ConsoleReport, type Finding, type MissionStore } from "@vibread/core";
import type { RegistryHooks } from "@vibread/tools";
import { Output, generateText } from "ai";
import { z } from "zod";
import type { AgentModels } from "./models.js";
import { RETRO_SYSTEM } from "./prompts.js";

export const RetroVoteSchema = z.object({
  verdict: z.enum(["GO", "NO-GO"]),
  summary: z.string().describe("One plain sentence for the person."),
  reasons: z.array(z.string()).describe("Short reasons for the vote."),
  concerns: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      title: z.string(),
      detail: z.string().optional(),
      fix: z.string().optional(),
      parts: z.array(z.string()).optional(),
    }),
  ),
});
export type RetroVote = z.infer<typeof RetroVoteSchema>;

/** RETRO reviewer (PLAN §5.2): sees brief, IR incl. sketch, suite, and every console; can only vote. */
export function createRetroReviewer(deps: { models: AgentModels; store: MissionStore }): { review: NonNullable<RegistryHooks["review"]> } {
  return {
    async review({ mission, revision, signal }) {
      const model = deps.models.fast();
      const consoles = revision.results.reports
        .filter((r) => r.console !== "RETRO")
        .map((r) => ({ console: r.console, verdict: r.verdict, summary: r.summary, findings: r.findings.map((f) => `${f.severity} ${f.ruleId}: ${f.title}`) }));
      const scenarios = revision.results.sim?.scenarios.map((s) => ({ id: s.id, title: s.title, ok: s.ok })) ?? [];
      const prompt = `Brief:\n${mission.brief}\n\nDesign (revision ${revision.n}):\n${JSON.stringify(revision.circuit, null, 2)}\n\n` +
        `Independent tests:\n${JSON.stringify(revision.suite?.scenarios.map((s) => ({ id: s.id, title: s.title, clauses: s.clauses, categories: s.categories })) ?? [], null, 2)}\n\n` +
        `Test results:\n${JSON.stringify(scenarios)}\nCoverage gaps: ${revision.results.sim?.coverage.missing.join("; ") || "none"}\n` +
        `Pin modes the compiled sketch actually set in simulation:\n${JSON.stringify(revision.results.sim?.pinModes ?? [])}\n\n` +
        `Console results:\n${JSON.stringify(consoles, null, 2)}\n\nVote now.`;
      const result = await generateText({
        model,
        system: RETRO_SYSTEM,
        prompt,
        output: Output.object({ schema: RetroVoteSchema, name: "retro_vote" }),
        ...(signal ? { abortSignal: signal } : {}),
      });
      return retroReport(result.output, revision.hash, deps.models.fastId);
    },
  };
}

/** A NO-GO vote always blocks, even when the reviewer listed no error-level concern. */
export function retroReport(vote: RetroVote, revisionHash: string, model: string): ConsoleReport {
  const findings: Finding[] = vote.concerns.map((c) => ({
    console: "RETRO",
    ruleId: "RETRO-CONCERN",
    severity: c.severity,
    title: c.title,
    ...(c.detail ? { detail: c.detail } : {}),
    ...(c.fix ? { fix: c.fix } : {}),
    ...(c.parts?.length ? { refs: { parts: c.parts } } : {}),
  }));
  if (vote.verdict === "NO-GO" && verdictOf(findings) === "GO") {
    findings.push({ console: "RETRO", ruleId: "RETRO-VOTE", severity: "error", title: vote.summary, detail: vote.reasons.join("\n") });
  }
  return {
    console: "RETRO",
    verdict: verdictOf(findings),
    summary: vote.summary,
    findings,
    evidence: { vote: vote.verdict, reasons: vote.reasons, model },
    revisionHash,
    at: new Date().toISOString(),
  };
}
