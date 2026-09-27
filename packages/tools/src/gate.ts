import { type ApprovalBroker, type ApprovalRequest, type MissionStore, type ToolContext, type ToolDef, type ToolRegistry } from "@vibread/core";
import { BENCH_ACTIONS, BENCH_ACTION_TEXT, ToolInputError, type BenchAction } from "./common.js";

/**
 * There are no permission modes: design and parts tools run directly for the design agent, Claude Code (MCP) and A2A.
 * Releasing a revision is only the person's "GO for build" (apps/server agents/release.ts). The one thing a tool can't
 * do is touch the board: physical tools only file a bench request that runs after a click at the bench.
 */

/** A physical tool's bench action ("flash-app", "run-selftest", …) — what the bench lists, starts, and iMessage pre-approves. */
export function brokerAction(def: ToolDef, args: unknown): string {
  const action = (args as { action?: unknown } | undefined)?.action;
  if (typeof action !== "string" || !(BENCH_ACTIONS as readonly string[]).includes(action)) throw new ToolInputError(`Unknown bench action ${String(action)}.`);
  return action;
}

/**
 * Files the bench request for a physical tool call, bound to the hash of the RELEASED revision (what the bench flashes
 * and tests), so a request can never run against a different design version. The tool's handler refuses first when
 * nothing is released, so the request is never filed against "no revision".
 */
export async function fileBenchRequest(input: { broker: ApprovalBroker; store: MissionStore; def: ToolDef; ctx: Pick<ToolContext, "missionId" | "actor">; args: unknown }): Promise<ApprovalRequest> {
  const { broker, store, def, ctx, args } = input;
  const action = brokerAction(def, args);
  const released = (await store.getMission(ctx.missionId))?.releasedRevision;
  const revision = released === undefined ? null : await store.getRevision(ctx.missionId, released);
  if (!revision) throw new ToolInputError("Nothing is released for the bench yet. Only the person can press GO for build: ask them to, then request the bench action again.");
  return broker.requestBench({
    missionId: ctx.missionId,
    action,
    input: args,
    revisionHash: revision.hash,
    actor: ctx.actor,
    summary: `Bench: ${BENCH_ACTION_TEXT[action as BenchAction]}`,
    consequence: "Runs only when you click Start at the bench that holds the USB cable.",
  });
}

export type GatedResult = { status: "executed"; output: unknown } | { status: "bench-click"; approval: ApprovalRequest; output: unknown };

/**
 * Tool invocation for non-streaming channels (MCP, A2A, CAPCOM): validates the input, runs the tool; a physical tool is
 * never executed — its handler only validates and describes the request (no side effects), then it is filed for a click
 * at the bench, so a refused request (wrong revision, nothing released) leaves nothing behind.
 */
export async function invokeTool(input: {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  store: MissionStore;
  ctx: ToolContext;
  name: string;
  args: unknown;
}): Promise<GatedResult> {
  const def = input.registry.get(input.name);
  if (!def) throw new ToolInputError(`Unknown tool ${input.name}.`);
  const parsed = def.input.safeParse(input.args);
  if (!parsed.success) throw new ToolInputError(`Invalid input for ${def.name}: ${parsed.error.message}`);
  const args = parsed.data;
  const output = await def.handler(input.ctx, args);
  if (def.actionClass !== "physical") return { status: "executed", output };
  const approval = await fileBenchRequest({ broker: input.broker, store: input.store, def, ctx: input.ctx, args });
  return { status: "bench-click", approval, output };
}
