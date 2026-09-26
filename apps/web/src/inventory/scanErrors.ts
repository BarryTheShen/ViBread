import { HttpError } from "../api/client.js";
import type { ScanView } from "@vibread/core";

function retryAtLabel(value: unknown): string | undefined {
  const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function scanErrorMessage(error: unknown, now = Date.now()): string {
  const message = error instanceof Error ? error.message : "The scan could not be read.";
  const retryAt = typeof error === "object" && error !== null && "retryAt" in error ? retryAtLabel(error.retryAt) : undefined;
  const status = error instanceof HttpError ? error.status : undefined;
  if (retryAt && (status === 429 || /rate.?limit|too many requests/i.test(message))) return `Claude is busy — try again after ${retryAt}`;
  if (status !== 429 && !/rate.?limit|too many requests/i.test(message)) return message;
  const clock = message.match(/(?:retry[- ]?after|try again after|after)\s*[:≈]?\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (clock?.[1]) return `Claude is busy — try again after ${clock[1]}`;
  const delay = message.match(/(?:retry[- ]?after|in)\D*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (delay?.[1] && delay[2]) {
    const amount = Number(delay[1]);
    const unit = delay[2].toLowerCase();
    const multiplier = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
    const retryAt = new Date(now + amount * multiplier);
    return `Claude is busy — try again after ${retryAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return "Claude is busy — try again later.";
}
/** Format a failed scan returned by GET /scans/:id, including persisted retry metadata. */
export function scanViewErrorMessage(scan: Pick<ScanView, "error" | "errorCode" | "retryAfter">): string {
  const error = Object.assign(new Error(scan.error ?? scan.errorCode ?? "The scan could not be read."), {
    retryAt: scan.retryAfter,
  });
  return scanErrorMessage(error);
}

/** Turn getUserMedia's DOMException names into an actionable instruction. */
export function cameraErrorMessage(error: unknown, secureContext: boolean): string {
  if (!secureContext) return "This HTTP address cannot use this computer's camera. Use the paired phone or upload a photo instead.";
  const name = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access in your browser and operating-system settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No compatible camera was found. Use the paired phone or upload a photo instead.";
  if (error instanceof Error && error.message) return `The camera could not start: ${error.message}`;
  return "The camera could not start. Use the paired phone or upload a photo instead.";
}

/** A local analysis error is terminal for the current attempt even if the server has not persisted failed yet. */
export function scanStatusAfterAnalysisError(status: "waiting" | "analyzing" | "ready" | "failed" | "accepted" | undefined, failed: boolean): "waiting" | "analyzing" | "ready" | "failed" | "accepted" | undefined {
  return failed ? "failed" : status;
}
