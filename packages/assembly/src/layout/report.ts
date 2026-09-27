import { verdictOf, type Circuit, type ConsoleReport, type Finding, type Layout, type LvsResult } from "@vibread/core";

import { LayoutFitError, layoutHash } from "./allocator.js";
import { placementSummary } from "./placement.js";
import { labelOrderProblems, layoutQuality } from "./quality.js";

export function assemblyReport(input: { circuit: Circuit; layout: Layout; lvs: LvsResult; revisionHash: string }): ConsoleReport {
  const findings: Finding[] = [];
  const quality = layoutQuality(input.circuit, input.layout);
  const placement = placementSummary(input.circuit, input.layout, quality);
  // Design philosophy rule 9: a spatial request the layout does not honour is a broken promise, so the design is not
  // GO. The fix says what the design agent can do: fix the order, or make room (bigger board, fewer parts) or relax the
  // request and say so. `toolSide` only tells the person-facing notices that no room is a ViBread limit.
  for (const group of placement.groups.filter((entry) => !entry.met)) {
    // An order the layout couldn't follow is the design's to fix; lack of room needs a bigger board or a smaller ask.
    findings.push(group.orderOnly
      ? {
          console: "FAO",
          ruleId: "PLACEMENT-UNMET",
          severity: "error",
          title: `${group.parts.join(", ")} are side by side but not in the order the placement group lists.`,
          detail: group.detail,
          fix: "List the group's parts left to right in exactly the order you want, give their Arduino pins one consistent direction along the row (consecutive pins), and keep labels like \"leftmost\" true; then call propose_design again.",
          refs: { parts: group.parts },
        }
      : {
          console: "FAO",
          ruleId: "PLACEMENT-UNMET",
          severity: "error",
          title: `ViBread could not place ${group.parts.join(", ")} as requested on the breadboard.`,
          detail: group.detail,
          fix: "There is no room for this arrangement on this breadboard. Use the bigger breadboard (bb-830) or fewer parts, or relax this placement request and say so in \"assumptions\"; then call propose_design again. Describe the layout only from the placement summary, never as if the request were met.",
          refs: { parts: group.parts },
          toolSide: true,
        });
  }
  // Layout quality (rules 2 and 4): the agent sees what makes this board hard to build and can fix the cause.
  if (quality.crossings > 0) {
    findings.push({
      console: "FAO",
      ruleId: "LAYOUT-CROSSINGS",
      severity: "warning",
      title: `${quality.crossings} pair${quality.crossings === 1 ? "" : "s"} of wires cross on the breadboard.`,
      detail: quality.crossingPairs.map(([a, b]) => `${a}×${b}`).join(", "),
      fix: "Usually the Arduino pins are not in the parts' order: give repeated units consecutive pins along the row, each pin family in the same direction (the layout turns the Uno to make one direction parallel). Keep the parts' left-to-right order the idea asks for.",
    });
  }
  const labelOrder = labelOrderProblems(input.circuit, input.layout);
  if (labelOrder.length > 0) {
    findings.push({
      console: "FAO",
      ruleId: "LAYOUT-LABEL-ORDER",
      severity: "warning",
      title: "Some parts don't sit where their labels say.",
      detail: labelOrder.join("; "),
      fix: "Make the order explicit with a row placement group (like parts listed left to right), or correct the labels so the build steps match the board.",
    });
  }
  for (const repeat of quality.repeats.filter((entry) => !entry.regular)) {
    findings.push({
      console: "FAO",
      ruleId: "LAYOUT-IRREGULAR",
      severity: "warning",
      title: `${repeat.copies.map((copy) => copy.join("+")).join(", ")} are the same circuit but are not built as identical copies.`,
      detail: `Leftmost columns ${repeat.columns.join(", ")}; the copies differ in shape or spacing (usually because a placement request or the board size left no room for a regular row).`,
      fix: "Not a design mistake. Mention it to the person; a bigger breadboard or dropping a conflicting placement request lets ViBread build them in one regular row.",
      toolSide: true,
    });
  }
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
      placement,
      quality: { wires: quality.wires, crossings: quality.crossings, wireLength: quality.wireLength, repeats: quality.repeats, score: quality.score },
    },
    revisionHash: input.revisionHash,
    at: new Date().toISOString(),
  };
}

/**
 * FAO report when `layoutBoard` throws `LayoutFitError`. When the design is valid but doesn't fit (`toolSide`), the fix
 * says how to make it fit: the bigger breadboard or fewer parts.
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
        fix: "The circuit is valid but doesn't fit this breadboard: switch to the bigger breadboard (bb-830) or use fewer parts, then call propose_design again. Proposing the same circuit on the same board won't fit.",
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
