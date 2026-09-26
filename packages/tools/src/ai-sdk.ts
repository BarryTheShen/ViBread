import type { ApprovalBroker, MissionStore, ToolContext, ToolRegistry } from "@vibread/core";
import { tool, type ToolSet } from "ai";
import { fileBenchRequest } from "./gate.js";

export interface AiToolsetOptions {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  store: MissionStore;
  /** Mission + acting agent for this run. */
  ctx: Pick<ToolContext, "missionId" | "actor">;
  /** Tool names to expose; all registry tools when omitted. */
  names?: string[];
}

/**
 * Adapts the registry to AI SDK tools. There are no approvals: every tool runs when the agent calls it, except physical
 * tools, which never run here — executing one only files a bench request that waits for a click at the bench.
 */
export function createAiToolset(options: AiToolsetOptions): { tools: ToolSet } {
  const { registry, broker, store, ctx } = options;
  const tools: ToolSet = {};
  for (const def of registry.list().filter((d) => !options.names || options.names.includes(d.name))) {
    tools[def.name] = tool({
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      execute: async (input: unknown, { abortSignal }) => {
        const toolCtx: ToolContext = { ...ctx, ...(abortSignal ? { signal: abortSignal } : {}) };
        const output = await def.handler(toolCtx, input);
        if (def.actionClass !== "physical") return output;
        // The handler only validates and describes; run it first so a refused request files nothing.
        const request = await fileBenchRequest({ broker, store, def, ctx, args: input });
        return { ...(output as Record<string, unknown>), status: "waiting-for-bench-click", approvalId: request.id };
      },
    });
  }
  return { tools };
}
