import { describe, expect, it } from "vitest";
import { HttpError } from "../api/client.js";
import { cameraErrorMessage, scanErrorMessage, scanStatusAfterAnalysisError, scanViewErrorMessage } from "./scanErrors.js";

describe("scan error mapping", () => {
  it("turns rate limits into a retry time and makes a failed attempt terminal", () => {
    expect(scanErrorMessage(new HttpError(429, "rate_limit_error", "retry-after 7:45 PM"))).toBe("Claude is busy — try again after 7:45 PM");
    expect(scanViewErrorMessage({ error: "Claude rate limited", errorCode: "claude_rate_limited", retryAfter: "2026-09-26T19:45:00.000Z" })).toMatch(/Claude is busy — try again after/);
    expect(scanStatusAfterAnalysisError("waiting", true)).toBe("failed");
  });

  it("distinguishes camera permission, missing camera, insecure context, and other errors", () => {
    expect(cameraErrorMessage({ name: "NotAllowedError" }, true)).toMatch(/permission was denied/i);
    expect(cameraErrorMessage({ name: "NotFoundError" }, true)).toMatch(/No compatible camera/i);
    expect(cameraErrorMessage(new Error("HTTP camera"), false)).toMatch(/HTTP address/i);
    expect(cameraErrorMessage(new Error("driver failed"), true)).toMatch(/driver failed/i);
  });
});
