import {
  MODE_LABELS,
  hashJson,
  type ApprovalBroker,
  type ApprovalRequest,
  type MissionStore,
  type PermissionMode,
  type Revision,
  type ToolContext,
  type ToolDef,
  type ToolRegistry,
} from "@vibread/core";
import { ToolInputError, allGo } from "./common.js";

/** Plain-language approval card text for a tool call (PLAN §5.8 "Approval card"). */
export function describeAction(def: ToolDef, input: unknown, nextRevision: number): { summary: string; consequence: string } {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (def.name) {
    case "propose_design": {
      const circuit = args.circuit as { title?: string } | undefined;
      return {
        summary: `Save revision ${nextRevision}${circuit?.title ? `: ${circuit.title}` : ""}${typeof args.note === "string" ? ` — ${args.note}` : ""}`,
        consequence: "Saves a new design revision and re-runs every check. Nothing physical happens.",
      };
    }
    case "release_revision":
      return {
        summary: `Release revision ${String(args.revision)} for building`,
        consequence: `Revision ${String(args.revision)}'s breadboard steps and firmware become what you build and flash.`,
      };
    case "add_part":
      return {
        summary: `Add ${String(args.count)}× ${String(args.module)} to your parts list`,
        consequence: "The design may then use a part you need to have on hand.",
      };
    case "request_bench_action":
      return { summary: `Bench: ${String(args.action)}`, consequence: "Runs only when you click Start at the bench." };
    default:
      return { summary: `${def.title}`, consequence: def.description };
  }
}

export interface PolicyDecision {
  outcome: "approved" | "denied" | "user-approval" | "bench-click";
  request?: ApprovalRequest;
  reason?: string;
  mode: PermissionMode;
}

/** The revision an action binds to: the released-to-be revision for release_revision, else the latest ("none" before any). */
async function boundRevision(store: MissionStore, def: ToolDef, missionId: string, args: unknown): Promise<{ latest: Revision | null; target: Revision | null; revisionHash: string }> {
  const latest = await store.getRevision(missionId);
  const target = def.name === "release_revision" ? await store.getRevision(missionId, Number((args as { revision?: number }).revision)) : latest;
  return { latest, target, revisionHash: target?.hash ?? latest?.hash ?? "none" };
}

/**
 * ApprovalRequest.actionHash for this exact call now (packages/core mission.ts: hashJson({ revisionHash, action, input })).
 * Consuming with it means an approval only runs the identical action on the unchanged revision.
 */
export async function currentActionHash(store: MissionStore, def: ToolDef, missionId: string, args: unknown): Promise<string> {
  const { revisionHash } = await boundRevision(store, def, missionId, args);
  return hashJson({ revisionHash, action: def.name, input: args });
}

/** Asks the ApprovalBroker (the authority, PLAN §5.10) about one tool call in the mission's current mode. */
export async function evaluatePolicy(input: {
  broker: ApprovalBroker;
  store: MissionStore;
  def: ToolDef;
  ctx: Pick<ToolContext, "missionId" | "actor">;
  args: unknown;
}): Promise<PolicyDecision> {
  const { broker, store, def, ctx, args } = input;
  const mission = await store.getMission(ctx.missionId);
  if (!mission) throw new ToolInputError(`Mission ${ctx.missionId} does not exist.`, 404);
  if (def.actionClass === "read-only") return { outcome: "approved", mode: mission.mode };
  const { latest, target, revisionHash } = await boundRevision(store, def, ctx.missionId, args);
  const { summary, consequence } = describeAction(def, args, (latest?.n ?? 0) + 1);
  const decision = await broker.evaluate({
    missionId: ctx.missionId,
    mode: mission.mode,
    actionClass: def.actionClass,
    action: def.name,
    input: args,
    revisionHash,
    actor: ctx.actor,
    summary,
    consequence,
    allGo: target ? allGo(target.results.reports) : false,
  });
  const reason =
    decision.reason ??
    (decision.outcome === "denied" ? `${MODE_LABELS[mission.mode]} mode: ${def.name} is shown as a proposal and not carried out.` : undefined);
  return { ...decision, ...(reason ? { reason } : {}), mode: mission.mode };
}

export type GatedResult =
  | { status: "executed"; output: unknown }
  | { status: "denied"; reason: string }
  | { status: "approval-required"; approval: ApprovalRequest }
  | { status: "bench-click"; approval?: ApprovalRequest; output: unknown };

/**
 * Policy-gated tool invocation for non-streaming channels (MCP, A2A, CAPCOM). Pass `approvalId` to execute a call that a
 * human approved earlier: the broker consumes it one-shot and only for the exact same action (hash of revision+action+input).
 * Physical actions are never executed: they become a bench-click request.
 */
export async function invokeTool(input: {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  store: MissionStore;
  ctx: Omit<ToolContext, "mode">;
  name: string;
  args: unknown;
  approvalId?: string;
}): Promise<GatedResult> {
  const def = input.registry.get(input.name);
  if (!def) throw new ToolInputError(`Unknown tool ${input.name}.`);
  const parsed = def.input.safeParse(input.args);
  if (!parsed.success) throw new ToolInputError(`Invalid input for ${def.name}: ${parsed.error.message}`);
  const args = parsed.data;

  if (input.approvalId) {
    const request = await input.broker.get(input.approvalId);
    if (!request || request.missionId !== input.ctx.missionId || request.action !== def.name) {
      return { status: "denied", reason: "That approval does not belong to this action." };
    }
    if (!(await input.broker.consume(request.id, await currentActionHash(input.store, def, input.ctx.missionId, args)))) {
      return { status: "denied", reason: `That approval is ${request.status === "pending" ? "still pending" : `not usable (${request.status})`}.` };
    }
    const mission = await input.store.getMission(input.ctx.missionId);
    return { status: "executed", output: await def.handler({ ...input.ctx, mode: mission?.mode ?? "review" }, args) };
  }

  const decision = await evaluatePolicy({ broker: input.broker, store: input.store, def, ctx: input.ctx, args });
  const ctx: ToolContext = { ...input.ctx, mode: decision.mode };
  switch (decision.outcome) {
    case "approved":
      return { status: "executed", output: await def.handler(ctx, args) };
    case "denied":
      return { status: "denied", reason: decision.reason ?? "Denied by policy." };
    case "user-approval":
      if (!decision.request) throw new Error("The approval broker asked for a human but created no request.");
      return { status: "approval-required", approval: decision.request };
    case "bench-click":
      return { status: "bench-click", ...(decision.request ? { approval: decision.request } : {}), output: await def.handler(ctx, args) };
  }
}
