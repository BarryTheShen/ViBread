import type { BenchRunResult, BuildState, ConsoleReport, MissionDetail, MissionPhase, Step } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { nextStepOf, releaseReadiness } from "./nextStep.js";

function detail(phase: MissionPhase, extra: { busy?: boolean; released?: number; current?: number; verdicts?: Record<string, ConsoleReport["verdict"]> } = {}): MissionDetail {
  const consoles = Object.entries(extra.verdicts ?? {}).map(([console, verdict]) => ({ console, verdict, summary: "", findings: [], revisionHash: "h", at: "" }) as ConsoleReport);
  return {
    mission: { id: "m", title: "t", brief: "b", ownerId: "o", phase, inventory: [], currentRevision: extra.current, releasedRevision: extra.released, createdAt: "", updatedAt: "" },
    revision: extra.current !== undefined ? { n: extra.current, hash: "h", author: { kind: "agent", id: "a", channel: "web" }, createdAt: "", verdicts: {} } : undefined,
    consoles,
    pendingApprovals: [],
    agentBusy: extra.busy ?? false,
  };
}

const build = (current: number, total: number): BuildState => ({
  missionId: "m",
  revision: 1,
  steps: Array.from({ length: total }, (_, i) => ({ n: i + 1 }) as Step),
  current,
  released: true,
  plug: "unplugged",
  updatedAt: "",
});

const run = (runId: string, verdict: BenchRunResult["verdict"]): BenchRunResult =>
  ({ runId, verdict, revision: 1, kind: "selftest", results: [], calibration: [], diagnosis: { attribution: "none", candidates: [], summary: "" } }) as BenchRunResult;

describe("nextStepOf", () => {
  it("walks the mission: working → GO → build n/N → bench → Arduino → confirm → done", () => {
    expect(nextStepOf(detail("DESIGN", { busy: true }))).toEqual({ kind: "working" });
    expect(nextStepOf(detail("GONOGO", { current: 1 }))).toEqual({ kind: "go" });
    expect(nextStepOf(detail("ASSEMBLE", { current: 1, released: 1 }), build(13, 33))).toEqual({ kind: "build", done: 12, total: 33 });
    expect(nextStepOf(detail("VERIFY", { current: 1, released: 1 }), build(33, 33))).toEqual({ kind: "bench" });
    expect(nextStepOf(detail("VERIFY", { current: 1, released: 1 }), build(33, 33), [run("virtual-1", "pass")])).toEqual({ kind: "bench-real" });
    expect(nextStepOf(detail("LAUNCH", { current: 1, released: 1 }))).toEqual({ kind: "confirm" });
    expect(nextStepOf(detail("DONE", { current: 1, released: 1 }))).toEqual({ kind: "done" });
  });

  it("an agent run takes precedence over every other state", () => {
    expect(nextStepOf(detail("ASSEMBLE", { busy: true, released: 1 }), build(5, 10))).toEqual({ kind: "working" });
  });

  it("only a virtual pass as the latest run means 'Test with your Arduino'; a later real failure goes back to the bench", () => {
    expect(nextStepOf(detail("DEBUG", { released: 1 }), undefined, [run("run-1", "fail")])).toEqual({ kind: "bench" });
    expect(nextStepOf(detail("VERIFY", { released: 1 }), undefined, [run("run-1", "incomplete"), run("virtual-2", "pass")])).toEqual({ kind: "bench-real" });
    expect(nextStepOf(detail("DEBUG", { released: 1 }), undefined, [run("virtual-1", "pass"), run("run-2", "fail")])).toEqual({ kind: "bench" });
    expect(nextStepOf(detail("VERIFY", { released: 1 }), undefined, [run("virtual-1", "fail")])).toEqual({ kind: "bench" });
    expect(nextStepOf(detail("VERIFY", { released: 1 }), undefined, [run("run-1", "pass"), run("virtual-2", "pass")])).toEqual({ kind: "bench" });
  });

  it("build progress starts at 0 and never goes negative", () => {
    expect(nextStepOf(detail("ASSEMBLE", { released: 1 }), build(1, 33))).toEqual({ kind: "build", done: 0, total: 33 });
    expect(nextStepOf(detail("ASSEMBLE", { released: 1 }))).toEqual({ kind: "build", done: 0, total: 0 });
  });
});

describe("releaseReadiness", () => {
  it("needs the four deterministic consoles GO; a missing review needs the waiver, a NO-GO review blocks", () => {
    const allGo = { EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO" } as const;
    expect(releaseReadiness(detail("GONOGO", { current: 2, verdicts: allGo }))).toMatchObject({ revision: 2, allRequiredGo: true, retroMissing: true, blocking: [] });
    expect(releaseReadiness(detail("GONOGO", { current: 2, verdicts: { ...allGo, RETRO: "NO-GO" } }))).toMatchObject({ allRequiredGo: false, retroMissing: false });
    expect(releaseReadiness(detail("GONOGO", { current: 2, verdicts: { ...allGo, FIDO: "PENDING" } }))).toMatchObject({ allRequiredGo: false, blocking: ["FIDO"] });
    expect(releaseReadiness(detail("GONOGO", { verdicts: allGo })).allRequiredGo).toBe(false);
  });
});
