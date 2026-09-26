import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Message, Usage } from "@earendil-works/pi-ai";
import type { Actor } from "@vibread/core";
import { errorMessage, type ToolTraceEvent } from "@vibread/tools";
import type { DebugLog } from "../services/debug-log.js";
import type { AgentModels, ClaudeModel, ModelTrace } from "./models.js";

/**
 * Agent-run tracing into the server's per-mission debug log (`ctx.debug`, services/debug-log.ts). Kept at the model /
 * tool / run-manager layer so it survives a harness change. Never logs a credential: only its kind.
 * VIBREAD_DEBUG=1 adds full prompts, model outputs, and tool inputs/outputs (the debug log caps and redacts them).
 */
export const traceVerbose = (): boolean => process.env.VIBREAD_DEBUG === "1";

export function actorForLog(actor: Actor): { kind: Actor["kind"]; id: string; channel: Actor["channel"] } {
  return { kind: actor.kind, id: actor.id, channel: actor.channel };
}

/** pi usage → log keys (never "token", which the debug log's secret filter redacts). */
function usageForLog(usage: Usage): Record<string, number> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.cost.total ? { costUsd: usage.cost.total } : {}),
  };
}

/** A request transcript for VIBREAD_DEBUG=1 logs: photos by size, never bytes. */
function transcriptForLog(messages: Message[]): unknown {
  return messages.map((message) =>
    typeof message.content === "string" || message.role === "assistant"
      ? message
      : { ...message, content: message.content.map((part) => (part.type === "image" ? { type: "image", mimeType: part.mimeType, bytes: Math.floor((part.data.length * 3) / 4) } : part)) },
  );
}

/** Every Claude request (a design-agent turn or a single-shot call) → the debug log: model, stop, usage, time, errors. */
function tracedModel(debug: DebugLog, trace: ModelTrace, resolved: ClaudeModel): ClaudeModel {
  const base = { purpose: trace.purpose, model: resolved.modelId, credential: resolved.credential.kind };
  const settled = (started: number, stream: boolean, messages: Message[], message: AssistantMessage) => {
    const toolCalls = message.content.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));
    const failed = message.stopReason === "error";
    debug.event(
      trace.missionId,
      "model",
      `${trace.purpose}: ${resolved.modelId} ${failed ? "failed" : message.stopReason}`,
      {
        ...base,
        stream,
        ms: Date.now() - started,
        stop: message.stopReason,
        ...(message.rawStopReason ? { stopRaw: message.rawStopReason } : {}),
        usage: usageForLog(message.usage),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
        ...(traceVerbose() ? { prompt: transcriptForLog(messages), output: message.content } : {}),
      },
      failed ? "error" : message.stopReason === "aborted" ? "warn" : "info",
    );
  };
  const thrown = (started: number, stream: boolean, error: unknown) =>
    debug.event(trace.missionId, "model", `${trace.purpose}: ${resolved.modelId} failed`, { ...base, stream, ms: Date.now() - started, error: errorMessage(error) }, "error");

  return {
    ...resolved,
    async streamFn(model, context, options) {
      const started = Date.now();
      let stream: AssistantMessageEventStream;
      try {
        stream = await resolved.streamFn(model, context, options);
      } catch (error) {
        thrown(started, true, error);
        throw error;
      }
      void stream.result().then((message) => settled(started, true, context.messages, message));
      return stream;
    },
    async complete(context, options) {
      const started = Date.now();
      try {
        const message = await resolved.complete(context, options);
        settled(started, false, context.messages, message);
        return message;
      } catch (error) {
        thrown(started, false, error);
        throw error;
      }
    },
  };
}

/** Every model call made through these models is traced to `debug` under the caller's mission and purpose. */
export function tracedModels(models: AgentModels, debug: DebugLog): AgentModels {
  const wrap = (role: "design" | "fast") => async (ownerId: string, trace: ModelTrace) => {
    try {
      return tracedModel(debug, trace, await models[role](ownerId, trace));
    } catch (error) {
      debug.event(trace.missionId, "model", `${trace.purpose}: no model available`, { purpose: trace.purpose, role, error: errorMessage(error) }, "warn");
      throw error;
    }
  };
  return { design: wrap("design"), fast: wrap("fast") };
}

/** Tool calls (agent, MCP, A2A, CAPCOM all run through the registry) → the mission's debug log. */
export function toolTracer(debug: DebugLog): (event: ToolTraceEvent) => void {
  return (event) => {
    const output = event.output as { summary?: unknown; verdicts?: unknown; allGo?: unknown; revision?: unknown } | undefined;
    const outcome = event.error ? `failed: ${event.error}` : typeof output?.summary === "string" ? output.summary : "done";
    debug.event(
      event.missionId,
      "tool",
      `${event.tool}: ${outcome}`.slice(0, 300),
      {
        tool: event.tool,
        actionClass: event.actionClass,
        actor: actorForLog(event.actor),
        ms: event.ms,
        ...(event.error ? { error: event.error } : {}),
        ...(output && typeof output === "object"
          ? { result: { ...(output.revision !== undefined ? { revision: output.revision } : {}), ...(output.verdicts ? { verdicts: output.verdicts } : {}), ...(output.allGo !== undefined ? { allGo: output.allGo } : {}) } }
          : {}),
        ...(traceVerbose() ? { input: event.input, output: event.output } : { inputKeys: event.input && typeof event.input === "object" ? Object.keys(event.input) : typeof event.input }),
      },
      event.error ? "warn" : "info",
    );
  };
}
