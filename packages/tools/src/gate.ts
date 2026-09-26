import {
  MODE_LABELS,
  hashJson,
  type ApprovalBroker,
  type ApprovalRequest,
  type InventoryItem,
  type MissionStore,
  type PermissionMode,
  type Revision,
  type ToolContext,
  type ToolDef,
  type ToolRegistry,
} from "@vibread/core";
import { BENCH_ACTIONS, BENCH_ACTION_TEXT, ToolInputError, allGo, type BenchAction } from "./common.js";

/** Plain-language approval card text for a tool call (PLAN §5.8 "Approval card"). */
/** True when the mission's parts list already has this module (and, when given, the same identifying params). */
function inMissionInventory(inventory: InventoryItem[], module: unknown, params: unknown): boolean {
  const wanted = (params ?? {}) as Record<string, unknown>;
  return inventory.some(
    (item) => item.module === module && Object.entries(wanted).every(([key, value]) => item.params?.[key] === undefined || item.params[key] === value),
  );
}

export function describeAction(
  def: ToolDef,
  input: unknown,
  nextRevision: number,
  context: { inventory?: InventoryItem[] } = {},
): { summary: string; consequence: string } {
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
    case "add_part": {
      const owned = context.inventory ? inMissionInventory(context.inventory, args.module, args.params) : true;
      return {
        summary: `Add ${String(args.count)}× ${String(args.module)} to your parts list${owned ? "" : " — not in your inventory"}`,
        consequence: owned
          ? "The design may then use a part you need to have on hand."
          : "You don't have this part in your inventory. Approve only if you have it (then add it to your inventory) or will get it.",
      };
    }
    case "request_bench_action": {
      const text = BENCH_ACTION_TEXT[args.action as BenchAction] ?? String(args.action);
      return { summary: `Bench: ${text}`, consequence: "Runs only when you click Start at the bench that holds the USB cable." };
    }
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
  let target = latest;
  if (def.name === "release_revision") target = await store.getRevision(missionId, Number((args as { revision?: number }).revision));
  else if (def.actionClass === "physical") {
    // The bench flashes and tests the RELEASED revision (the build target), so a bench request is bound to its hash:
    // an approval must never run against a different design version (PLAN §5.10). The request tool refuses when
    // nothing is released, so "none" is never filed.
    const released = (await store.getMission(missionId))?.releasedRevision;
    target = released === undefined ? null : await store.getRevision(missionId, released);
    return { latest, target, revisionHash: target?.hash ?? "none" };
  }
  return { latest, target, revisionHash: target?.hash ?? latest?.hash ?? "none" };
}

/**
 * The broker's `action` for a tool call: the tool name, except for physical tools, whose action is the bench action
 * itself ("flash-app", "run-selftest", …) — that is what the bench lists, starts, and iMessage pre-approves.
 */
export function brokerAction(def: ToolDef, args: unknown): string {
  if (def.actionClass !== "physical") return def.name;
  const action = (args as { action?: unknown } | undefined)?.action;
  if (typeof action !== "string" || !(BENCH_ACTIONS as readonly string[]).includes(action)) throw new ToolInputError(`Unknown bench action ${String(action)}.`);
  return action;
}

/**
 * ApprovalRequest.actionHash for this exact call now (packages/core mission.ts: hashJson({ revisionHash, action, input })).
 * Consuming with it means an approval only runs the identical action on the unchanged revision.
 */
export async function currentActionHash(store: MissionStore, def: ToolDef, missionId: string, args: unknown): Promise<string> {
  const { revisionHash } = await boundRevision(store, def, missionId, args);
  return hashJson({ revisionHash, action: brokerAction(def, args), input: args });
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
  const { summary, consequence } = describeAction(def, args, (latest?.n ?? 0) + 1, { inventory: mission.inventory });
  const decision = await broker.evaluate({
    missionId: ctx.missionId,
    mode: mission.mode,
    actionClass: def.actionClass,
    action: brokerAction(def, args),
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
    if (!request || request.missionId !== input.ctx.missionId || request.action !== brokerAction(def, args)) {
      return { status: "denied", reason: "That approval does not belong to this action." };
    }
    if (!(await input.broker.consume(request.id, await currentActionHash(input.store, def, input.ctx.missionId, args)))) {
      return { status: "denied", reason: `That approval is ${request.status === "pending" ? "still pending" : `not usable (${request.status})`}.` };
    }
    const mission = await input.store.getMission(input.ctx.missionId);
    return { status: "executed", output: await def.handler({ ...input.ctx, mode: mission?.mode ?? "review" }, args) };
  }

  if (def.actionClass === "physical") {
    // Never executed here: the handler validates and describes the request (no side effects) before it is filed as a
    // bench-click request, so a refused request (wrong revision, no design) leaves nothing on the bench.
    const mission = await input.store.getMission(input.ctx.missionId);
    const output = await def.handler({ ...input.ctx, mode: mission?.mode ?? "review" }, args);
    const decision = await evaluatePolicy({ broker: input.broker, store: input.store, def, ctx: input.ctx, args });
    return { status: "bench-click", ...(decision.request ? { approval: decision.request } : {}), output };
  }
  const decision = await evaluatePolicy({ broker: input.broker, store: input.store, def, ctx: input.ctx, args });
  const ctx: ToolContext = { ...input.ctx, mode: decision.mode };
  // An identical action a human already approved and nobody has used: consume it one-shot, then run it.
  const granted = decision.request;
  if (granted?.status === "approved" && (decision.outcome === "approved" || decision.outcome === "user-approval")) {
    if (!(await input.broker.consume(granted.id, await currentActionHash(input.store, def, input.ctx.missionId, args)))) {
      return { status: "denied", reason: "That approval was already used." };
    }
    return { status: "executed", output: await def.handler(ctx, args) };
  }
  switch (decision.outcome) {
    case "approved":
      return { status: "executed", output: await def.handler(ctx, args) };
    case "denied":
      return { status: "denied", reason: decision.reason ?? "Denied by policy." };
    case "user-approval":
      if (!decision.request) throw new Error("The approval broker asked for a human but created no request.");
      return { status: "approval-required", approval: decision.request };
    case "bench-click":
      throw new Error("Only physical tools are bench-click actions.");
  }
}
