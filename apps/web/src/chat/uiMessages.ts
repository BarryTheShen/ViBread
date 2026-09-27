import { isRecord } from "../lib/guards.js";

/** Mark on messages replayed from a recorded real-model run (`metadata.vibread.recorded`), never a live reply. */
export function recordedLabelOf(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.vibread) || !isRecord(metadata.vibread.recorded)) return undefined;
  const label = metadata.vibread.recorded.label;
  return typeof label === "string" ? label : undefined;
}

/** Mark on a reply cut off with Stop (`metadata.vibread.stopped`, saved by the server with the partial reply). */
export function isStoppedReply(metadata: unknown): boolean {
  return isRecord(metadata) && isRecord(metadata.vibread) && metadata.vibread.stopped === true;
}

/**
 * Mark on the reply the server saves when a run couldn't start (`metadata.vibread.error`, e.g. Claude not connected):
 * its text is the reason, so it is shown as the error itself, never next to a second copy of it.
 */
export function isErrorReply(metadata: unknown): boolean {
  return isRecord(metadata) && isRecord(metadata.vibread) && metadata.vibread.error === true;
}

/** One-line result the agent tools always include (`{ summary }`). */
export function toolSummaryOf(output: unknown): string | undefined {
  return isRecord(output) && typeof output.summary === "string" ? output.summary : undefined;
}
