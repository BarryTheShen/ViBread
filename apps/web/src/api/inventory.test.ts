import { describe, expect, it } from "vitest";
import { scanPollingInterval } from "./inventory.js";

describe("scan polling", () => {
  it("continues polling photo sessions until the server reaches a terminal state", () => {
    expect(scanPollingInterval("waiting")).toBe(1_500);
    expect(scanPollingInterval("analyzing")).toBe(1_500);
    expect(scanPollingInterval(undefined)).toBe(1_500);
    expect(scanPollingInterval("ready")).toBe(false);
    expect(scanPollingInterval("failed")).toBe(false);
    expect(scanPollingInterval("accepted")).toBe(false);
  });
});
