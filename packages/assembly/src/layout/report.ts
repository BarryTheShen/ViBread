import { verdictOf, type Circuit, type ConsoleReport, type Finding, type Layout, type LvsResult } from "@vibread/core";

import { layoutHash } from "./allocator.js";

export function assemblyReport(input: { circuit: Circuit; layout: Layout; lvs: LvsResult; revisionHash: string }): ConsoleReport {
  const findings: Finding[] = [];
  if (input.lvs.issues.length > 0) {
    for (const issue of input.lvs.issues) {
      findings.push({
        console: "FAO",
        ruleId: `LVS-${issue.kind.toUpperCase()}`,
        severity: issue.severity,
        title: issue.message,
        detail: [issue.nets?.join(", "), issue.pins?.join(", "), issue.holes?.join(", ")].filter(Boolean).join(" · ") || undefined,
        fix: "Follow the highlighted hole and pin labels, then rerun the assembly check.",
        refs: { nets: issue.nets, pins: issue.pins, holes: issue.holes },
      });
    }
  }
  if (input.lvs.ok) {
    findings.push({
      console: "FAO",
      ruleId: "LVS-CLEAN",
      severity: "info",
      title: "Every placed part and jumper matches the intended netlist.",
      detail: `${input.lvs.derivedNets.length} derived physical nets; layout ${layoutHash(input.layout).slice(0, 8)}.`,
    });
  }
  const verdict = verdictOf(findings);
  return {
    console: "FAO",
    verdict,
    summary: verdict === "GO" ? "The breadboard fits and LVS is clean." : "Fix the highlighted assembly finding before powering the build.",
    findings,
    evidence: {
      fits: input.lvs.issues.every((issue) => issue.kind !== "invalid-hole" && issue.kind !== "unplaced-part"),
      lvsClean: input.lvs.ok,
      placements: input.layout.placements.length,
      jumpers: input.layout.jumpers.length,
    },
    revisionHash: input.revisionHash,
    at: new Date().toISOString(),
  };
}
