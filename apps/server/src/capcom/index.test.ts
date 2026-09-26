import { describe, expect, it, vi } from "vitest";
import { cloudSendDelayMs, faultAlertText, isFaultAlertEvent, isQuietHours, shouldSendCelebrationEffect } from "./index.js";

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
});
