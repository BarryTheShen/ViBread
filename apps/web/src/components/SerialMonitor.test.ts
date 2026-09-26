import { describe, expect, it } from "vitest";
import { isSerialMonitorAtBottom } from "./SerialMonitor.js";

describe("isSerialMonitorAtBottom", () => {
  it("turns auto-scroll off above the bottom tolerance and on at the bottom", () => {
    expect(isSerialMonitorAtBottom(1_000, 667, 300)).toBe(false);
    expect(isSerialMonitorAtBottom(1_000, 700, 300)).toBe(true);
    expect(isSerialMonitorAtBottom(1_000, 668, 300, 32)).toBe(true);
  });
});
