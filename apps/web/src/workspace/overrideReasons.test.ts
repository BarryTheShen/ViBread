import type { ConsoleReport, MissionDetail } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { overrideReasons } from "./overrideReasons.js";

function detail(verdicts: Record<string, ConsoleReport["verdict"]>, findings: Record<string, ConsoleReport["findings"]> = {}): MissionDetail {
  const consoles = Object.entries(verdicts).map(([console, verdict]) => ({ console, verdict, summary: "", findings: findings[console] ?? [], revisionHash: "h", at: "" }) as ConsoleReport);
  return {
    mission: { id: "m", title: "t", brief: "b", ownerId: "o", phase: "GONOGO", inventory: [], currentRevision: 1, createdAt: "", updatedAt: "" },
    revision: { n: 1, hash: "h", author: { kind: "agent", id: "a", channel: "web" }, createdAt: "", verdicts: {} },
    consoles,
    pendingApprovals: [],
    agentBusy: false,
  };
}

const FOUR_GO = { EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO" } as const;

describe("overrideReasons", () => {
  it("names the missing review when the override is opened from the review-waiver confirm, before any server refusal", () => {
    expect(overrideReasons(detail(FOUR_GO), undefined)).toEqual(["Independent review (RETRO) not run"]);
  });

  it("lists a pending review once, not also as 'not run'", () => {
    expect(overrideReasons(detail({ ...FOUR_GO, RETRO: "PENDING" }), undefined)).toEqual(["Independent review (RETRO) PENDING"]);
  });

  it("lists each console that isn't GO, with FIDO's failing scenarios", () => {
    const failing: ConsoleReport["findings"] = [{ console: "FIDO", ruleId: "FIDO-FAIL", severity: "error", title: "S2 failed", refs: { scenarios: ["S2"] } }];
    expect(overrideReasons(detail({ ...FOUR_GO, FIDO: "NO-GO", RETRO: "GO" }, { FIDO: failing }), { code: "not_all_go", message: "FIDO NO-GO" })).toEqual([
      "Simulation tests (FIDO) NO-GO — failing scenarios: S2",
    ]);
  });

  it("falls back to the server's message when no console explains the refusal", () => {
    expect(overrideReasons(detail({ ...FOUR_GO, RETRO: "GO" }), { code: "not_all_go", message: "Revision changed." })).toEqual(["Revision changed."]);
  });
});
