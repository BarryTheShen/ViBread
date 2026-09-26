import { describe, expect, it, vi } from "vitest";
import { approvalOutcome, benchAskOptionTitle, benchAskValueForOption, capcomLinkUrl, cloudSendDelayMs, faultAlertText, isFaultAlertEvent, isQuietHours, isSelectedPollOption, isSupportedInboundContentType, missionSelection, pendingApprovalIndex, pollTitleForApproval, shouldSendCelebrationEffect } from "./index.js";

describe("CAPCOM timeline alerts", () => {
  it("does not duplicate the Houston prefix from bench diagnoses", () => {
    const summary = "Houston, we have a problem: LED1 blinked as light 2 — check the LED jumpers.";

    expect(faultAlertText(summary)).toBe(summary);
    expect(faultAlertText("LED1 blinked as light 2 — check the LED jumpers.")).toBe(summary);
  });

  it("does not turn a passing bench run into a Houston alert", () => {
    const base = { id: "event", missionId: "mission", at: new Date().toISOString(), channel: "web" as const, actor: { kind: "human" as const, id: "operator", channel: "web" as const }, text: "All bench checks passed." };

    expect(isFaultAlertEvent({ ...base, kind: "bench.run", data: { verdict: "pass" } })).toBe(false);
    expect(isFaultAlertEvent({ ...base, kind: "bench.run", data: { verdict: "fail" } })).toBe(true);
  });

  it("uses text instead of unsupported terminal effects for celebration", () => {
    expect(shouldSendCelebrationEffect(false)).toBe(false);
    expect(shouldSendCelebrationEffect(true)).toBe(true);
  });

  it("guards cloud sends during quiet hours and spaces bursts", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 26, 23, 0));
      expect(isQuietHours()).toBe(true);
      vi.setSystemTime(new Date(2026, 8, 26, 6, 59));
      expect(isQuietHours()).toBe(true);
      vi.setSystemTime(new Date(2026, 8, 26, 7, 0));
      expect(isQuietHours()).toBe(false);
      vi.setSystemTime(new Date(2026, 8, 26, 22, 59));
      expect(isQuietHours()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(cloudSendDelayMs(0)).toBe(750);
    expect(cloudSendDelayMs(500)).toBe(250);
    expect(cloudSendDelayMs(750)).toBe(0);
    expect(cloudSendDelayMs(1_000)).toBe(0);
  });

  it("binds poll votes to the selected approval instead of FIFO", () => {
    const first = { id: "approval-one", missionId: "mission", actionClass: "physical" as const, summary: "Flash", consequence: "Runs at bench" };
    const second = { id: "approval-two", missionId: "mission", actionClass: "physical" as const, summary: "Self-test", consequence: "Runs at bench" };
    const queue = [
      { notice: first, pollTitle: pollTitleForApproval(first) },
      { notice: second, pollTitle: pollTitleForApproval(second) },
    ];

    expect(pendingApprovalIndex(queue, pollTitleForApproval(second))).toBe(1);
    expect(pendingApprovalIndex(queue)).toBe(0);
  });

  it("distinguishes mission listing and attachment commands from briefs", () => {
    expect(missionSelection("mission")).toBeNull();
    expect(missionSelection("mission 2")).toBe(2);
    expect(missionSelection("mission: build a lamp")).toBeUndefined();
  });

  it("maps bench ask choices to poll labels and back", () => {
    const ask = { choices: ["1", "2", "none"] };

    expect(benchAskOptionTitle("none")).toBe("None of them");
    expect(benchAskValueForOption(ask, "None of them")).toBe("none");
    expect(benchAskValueForOption(ask, "2")).toBe("2");
    expect(benchAskValueForOption(ask, "5")).toBeUndefined();
  });

  it("ignores read receipts, poll deselection, and stale approval decisions", () => {
    expect(isSupportedInboundContentType("text")).toBe(true);
    expect(isSupportedInboundContentType("attachment")).toBe(true);
    expect(isSupportedInboundContentType("poll_option")).toBe(true);
    expect(isSupportedInboundContentType("read")).toBe(false);
    expect(isSupportedInboundContentType("reaction")).toBe(false);
    expect(isSelectedPollOption({ selected: false })).toBe(false);
    expect(isSelectedPollOption({ selected: true })).toBe(true);
    expect(approvalOutcome("approved", "approve-once", "approve-once")).toBe("approved");
    expect(approvalOutcome("denied", "deny", "approve-once")).toBe("decided");
    expect(approvalOutcome("expired", "approve-once", "approve-once")).toBe("expired");
  });

  it("builds phone-reachable CAPCOM links from phoneUrl", () => {
    expect(capcomLinkUrl("http://192.168.1.24:8787/")).toBe("http://192.168.1.24:8787/");
    expect(capcomLinkUrl("https://vibread.example")).toBe("https://vibread.example/");
  });
});
