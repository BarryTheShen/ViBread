import { describe, expect, it } from "vitest";
import { approvalGate } from "./approval.js";

const connected = { connected: true, safeReady: true, railsReady: true, passed: true, loadedRevision: 1, requestRevision: 1 };

describe("approvalGate", () => {
  it("blocks every physical approval before its sequence point", () => {
    expect(approvalGate("flash-bench", { ...connected, connected: false })).toEqual({ ok: false, reason: "Connect the board first" });
    expect(approvalGate("rail-checkpoint", { ...connected, safeReady: false })).toEqual({ ok: false, reason: "Make the board safe first" });
    expect(approvalGate("run-selftest", { ...connected, railsReady: false })).toEqual({ ok: false, reason: "Check the power first" });
    expect(approvalGate("flash-app", { ...connected, passed: false })).toEqual({ ok: false, reason: "Needs a passing self-test first" });
  });

  it("blocks requests for another loaded revision before a start POST", () => {
    expect(approvalGate("flash-app", { ...connected, requestRevision: 2 })).toEqual({ ok: false, reason: "This request is for revision 2; the bench has revision 1 loaded" });
  });

  it("allows only the current sequence action", () => {
    expect(approvalGate("flash-bench", connected)).toEqual({ ok: true });
    expect(approvalGate("rail-checkpoint", connected)).toEqual({ ok: true });
    expect(approvalGate("run-selftest", connected)).toEqual({ ok: true });
    expect(approvalGate("flash-app", connected)).toEqual({ ok: true });
  });
});
