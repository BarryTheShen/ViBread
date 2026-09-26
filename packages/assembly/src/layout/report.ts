import { verdictOf, type Circuit, type ConsoleReport, type Finding, type Layout, type LvsResult } from "@vibread/core";

import { LayoutFitError, layoutHash } from "./allocator.js";

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

/**
 * FAO report when `layoutBoard` throws `LayoutFitError`. A tool-side failure (the design is valid but ViBread cannot
 * place it) is flagged `toolSide` so the design agent stops redesigning and tells the user instead.
 */
export function layoutFailureReport(input: { error: LayoutFitError; revisionHash: string }): ConsoleReport {
  const { error } = input;
  const finding: Finding = error.toolSide
    ? {
        console: "FAO",
        ruleId: "LAYOUT-NO-FIT",
        severity: "error",
        title: "ViBread could not lay this circuit out on the breadboard.",
        detail: error.message,
        fix: "This is a ViBread limit, not a design mistake: a bigger breadboard (830 points) or fewer parts will fit; redesigning the same circuit will not help.",
        toolSide: true,
      }
    : {
        console: "FAO",
        ruleId: "LAYOUT-DESIGN",
        severity: "error",
        title: "The design cannot be built as drawn.",
        detail: error.message,
        fix: "Change the connection named above.",
      };
  return {
    console: "FAO",
    verdict: "NO-GO",
    summary: error.toolSide ? "ViBread could not fit this circuit on the breadboard." : "The design cannot be built as drawn.",
    findings: [finding],
    evidence: { fits: false, lvsClean: false },
    revisionHash: input.revisionHash,
    at: new Date().toISOString(),
  };
}
