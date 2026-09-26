import { isRecord } from "../lib/guards.js";

/** Mark on messages replayed from a recorded real-model run (`metadata.vibread.recorded`), never a live reply. */
export function recordedLabelOf(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.vibread) || !isRecord(metadata.vibread.recorded)) return undefined;
  const label = metadata.vibread.recorded.label;
  return typeof label === "string" ? label : undefined;
}

/** One-line result the agent tools always include (`{ summary }`). */
export function toolSummaryOf(output: unknown): string | undefined {
  return isRecord(output) && typeof output.summary === "string" ? output.summary : undefined;
}
