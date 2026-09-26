import type { ApprovalBroker, ApprovalRequest, MissionStore, ToolContext, ToolRegistry } from "@vibread/core";
import { tool, type ToolApprovalStatus, type ToolSet, type TypedToolCall } from "ai";
import { currentActionHash, evaluatePolicy } from "./gate.js";

export interface AiToolsetOptions {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  store: MissionStore;
  /** Mission + acting agent for this run; the permission mode is re-read from the store on every call. */
  ctx: Omit<ToolContext, "mode">;
  /** Tool names to expose; all registry tools when omitted. */
  names?: string[];
  /** Broker requests created for earlier tool calls of this chat (toolCallId → request), restored on resume. */
  approvals?: Map<string, ApprovalRequest>;
}

export interface AiToolset {
  tools: ToolSet;
  /** Pass as `toolApproval` to streamText/generateText. */
  toolApproval: (options: { toolCall: TypedToolCall<ToolSet> }) => Promise<ToolApprovalStatus>;
  /** toolCallId → broker request for calls that are waiting for (or got) a human decision. */
  approvals: Map<string, ApprovalRequest>;
}

/**
 * Adapts the registry to AI SDK tools. `toolApproval` maps each call through the ApprovalBroker (policyFor):
 * read-only → run; state-changing/release/bom-change → approved | denied | user-approval; physical → never run by the
 * agent: executing it only files a bench-click request. A call a human approved is consumed one-shot in `execute`, so a
 * replayed or resumed history can't run it twice.
 */
export function createAiToolset(options: AiToolsetOptions): AiToolset {
  const { registry, broker, store, ctx } = options;
  const approvals = options.approvals ?? new Map<string, ApprovalRequest>();
  const defs = registry.list().filter((d) => !options.names || options.names.includes(d.name));
  const tools: ToolSet = {};

  for (const def of defs) {
    tools[def.name] = tool({
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      execute: async (input: unknown, { toolCallId, abortSignal }) => {
        const mission = await store.getMission(ctx.missionId);
        const toolCtx: ToolContext = { ...ctx, mode: mission?.mode ?? "review", ...(abortSignal ? { signal: abortSignal } : {}) };
        if (def.actionClass === "physical") {
          // The handler only validates and describes (no side effects); run it first so a refused request files nothing.
          const output = (await def.handler(toolCtx, input)) as Record<string, unknown>;
          const decision = await evaluatePolicy({ broker, store, def, ctx, args: input });
          return { ...output, status: "waiting-for-bench-click", ...(decision.request ? { approvalId: decision.request.id } : {}) };
        }
        const approved = approvals.get(toolCallId);
        if (approved && !(await broker.consume(approved.id, await currentActionHash(store, def, ctx.missionId, input)))) {
          throw new Error("This approval can't be used: it was already used, expired, or was for a different action.");
        }
        return def.handler(toolCtx, input);
      },
    });
  }

  async function toolApproval({ toolCall }: { toolCall: TypedToolCall<ToolSet> }): Promise<ToolApprovalStatus> {
    const def = registry.get(toolCall.toolName);
    if (!def) return { type: "denied", reason: `Unknown tool ${toolCall.toolName}.` };
    if (def.actionClass === "read-only" || def.actionClass === "physical") return "not-applicable";

    const known = approvals.get(toolCall.toolCallId);
    if (known) {
      // Resume after a human decision: the broker's record is the authority, not the chat history.
      const current = await broker.get(known.id);
      if (current?.status === "approved") return "approved";
      if (current?.status === "pending") return { type: "user-approval", reason: current.summary };
      return { type: "denied", reason: `The approval is ${current?.status ?? "missing"}.` };
    }

    const decision = await evaluatePolicy({ broker, store, def, ctx, args: toolCall.input });
    // The broker hands back an identical action a human already approved (and nobody used yet): run it; `execute`
    // consumes it one-shot, so it can't run twice.
    if (decision.request?.status === "approved" && (decision.outcome === "approved" || decision.outcome === "user-approval")) {
      approvals.set(toolCall.toolCallId, decision.request);
      return "approved";
    }
    switch (decision.outcome) {
      case "approved":
        return "approved";
      case "user-approval":
        if (!decision.request) return { type: "denied", reason: "The approval broker created no request." };
        approvals.set(toolCall.toolCallId, decision.request);
        return { type: "user-approval", reason: decision.request.summary };
      case "denied":
      case "bench-click":
        return { type: "denied", reason: decision.reason ?? "Denied by policy." };
    }
  }

  return { tools, toolApproval, approvals };
}
