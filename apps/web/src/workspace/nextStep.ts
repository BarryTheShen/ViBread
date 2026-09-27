import { isPracticeRun, type BenchRunResult, type BuildState, type ConsoleId, type MissionDetail } from "@vibread/core";
import type { NextStep } from "../contracts.js";

const REQUIRED: ConsoleId[] = ["EECOM", "GUIDO", "FIDO", "FAO"];

export interface ReleaseReadiness {
  revision?: number;
  released: boolean;
  /** Electrical, firmware, simulation and assembly are GO and the independent review didn't vote NO-GO. */
  allRequiredGo: boolean;
  /** The independent review hasn't voted (no Claude credential): GO needs the "without review" waiver. */
  retroMissing: boolean;
  blocking: ConsoleId[];
}

/** Where "GO for build" stands for the mission's current revision (PLAN §5.4 Go/No-Go poll). */
export function releaseReadiness(detail: MissionDetail): ReleaseReadiness {
  const revision = detail.revision?.n;
  const verdict = (id: ConsoleId) => detail.consoles.find((c) => c.console === id)?.verdict;
  const blocking = REQUIRED.filter((id) => verdict(id) !== "GO");
  const retro = verdict("RETRO");
  return {
    revision,
    released: revision !== undefined && detail.mission.releasedRevision === revision,
    allRequiredGo: revision !== undefined && blocking.length === 0 && retro !== "NO-GO",
    retroMissing: retro === undefined || retro === "PENDING" || retro === "SKIPPED",
    blocking,
  };
}

/** A virtual pass means the real Arduino test is next, unless a real pass already exists. */
export function practicePassedLast(runs: readonly BenchRunResult[] | undefined): boolean {
  const last = runs?.at(-1);
  const latestPhysical = runs?.findLast((candidate) => !isPracticeRun(candidate));
  return last !== undefined && isPracticeRun(last) && last.verdict === "pass" && latestPhysical?.verdict !== "pass";
}

/** Steps finished: every step once the build is over, else the ones before the builder's current step. */
export function buildProgress(detail: MissionDetail, build: BuildState | undefined): { done: number; total: number } {
  const total = build?.steps.length ?? 0;
  const buildOver = ["VERIFY", "DEBUG", "LAUNCH", "DONE"].includes(detail.mission.phase);
  return { done: buildOver ? total : Math.max(0, (build?.current ?? 1) - 1), total };
}

/**
 * What the header's next-step button shows (plan §2). `bench` = the released revision's bench runs; it is only needed
 * to tell "Test on the bench" from "Test with your Arduino" after a virtual-board pass (the phase doesn't move then).
 */
export function nextStepOf(detail: MissionDetail, build?: BuildState, bench?: readonly BenchRunResult[]): NextStep {
  const phase = detail.mission.phase;
  if (detail.agentBusy) return { kind: "working" };
  if (phase === "DONE") return { kind: "done" };
  if (phase === "LAUNCH") return { kind: "confirm" };
  if (phase === "VERIFY" || phase === "DEBUG") return practicePassedLast(bench) ? { kind: "bench-real" } : { kind: "bench" };
  if (phase === "ASSEMBLE" && detail.mission.releasedRevision !== undefined) return { kind: "build", ...buildProgress(detail, build) };
  return { kind: "go" };
}
