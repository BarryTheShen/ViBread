export type BenchApprovalAction = "flash-bench" | "rail-checkpoint" | "run-selftest" | "flash-app";

export interface ApprovalGateContext {
  connected: boolean;
  safeReady: boolean;
  railsReady: boolean;
  passed: boolean;
  loadedRevision: number;
  requestRevision: number;
}

export interface ApprovalGateResult {
  ok: boolean;
  reason?: string;
}

/** Physical approval requests never bypass the bench sequence. */
export function approvalGate(action: BenchApprovalAction, context: ApprovalGateContext): ApprovalGateResult {
  if (context.loadedRevision !== context.requestRevision) return { ok: false, reason: `This request is for revision ${context.requestRevision}; the bench has revision ${context.loadedRevision} loaded` };
  if (!context.connected) return { ok: false, reason: "Connect the board first" };
  if (action === "flash-bench") return { ok: true };
  if (!context.safeReady) return { ok: false, reason: "Make the board safe first" };
  if (action === "rail-checkpoint") return { ok: true };
  if (!context.railsReady) return { ok: false, reason: "Check the power first" };
  if (!context.passed) return { ok: false, reason: "Needs a passing self-test first" };
  return { ok: true };
}
