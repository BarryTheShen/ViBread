import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FinishReason, LanguageModelV4Middleware, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { Actor } from "@vibread/core";
import { errorMessage, type ToolTraceEvent } from "@vibread/tools";
import { wrapLanguageModel } from "ai";
import type { DebugLog } from "../services/debug-log.js";
import type { AgentModels, ModelCredential, ModelTrace } from "./models.js";

/**
 * Agent-run tracing into the server's per-mission debug log (`ctx.debug`, services/debug-log.ts). Kept at the model /
 * tool / run-manager layer so it survives a harness change. Never logs a credential: only its kind.
 * VIBREAD_DEBUG=1 adds full prompts, model outputs, and tool inputs/outputs (the debug log caps and redacts them).
 */
export const traceVerbose = (): boolean => process.env.VIBREAD_DEBUG === "1";

export function actorForLog(actor: Actor): { kind: Actor["kind"]; id: string; channel: Actor["channel"] } {
  return { kind: actor.kind, id: actor.id, channel: actor.channel };
}

/** Token counts under keys the debug log's secret filter leaves alone (it redacts any key containing "token"). */
function usageForLog(usage: LanguageModelV4Usage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  const put = (key: string, value: number | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put("input", usage.inputTokens.total);
  put("output", usage.outputTokens.total);
  put("cacheRead", usage.inputTokens.cacheRead);
  put("cacheWrite", usage.inputTokens.cacheWrite);
  put("reasoning", usage.outputTokens.reasoning);
  return out;
}

/** Prompts carry photos; the log gets their size, never the bytes. */
function promptForLog(prompt: LanguageModelV4CallOptions["prompt"]): unknown {
  return prompt.map((message) => {
    if (typeof message.content === "string") return message;
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.type !== "file") return part;
        const file = part.data;
        const where =
          file.type === "data"
            ? { bytes: typeof file.data === "string" ? Math.floor((file.data.length * 3) / 4) : file.data.byteLength }
            : file.type === "url"
              ? { url: String(file.url) }
              : { source: file.type };
        return { type: "file", mediaType: part.mediaType, ...where };
      }),
    };
  });
}

function contentForLog(content: LanguageModelV4Content[]): unknown {
  return content.map((part) => (part.type === "file" ? { type: "file", mediaType: part.mediaType } : part));
}

function modelMiddleware(debug: DebugLog, trace: ModelTrace, modelId: string, credential: ModelCredential): LanguageModelV4Middleware {
  const base = { purpose: trace.purpose, model: modelId, credential: credential.kind };
  const finished = (input: { started: number; params: LanguageModelV4CallOptions; finish?: LanguageModelV4FinishReason; usage?: LanguageModelV4Usage; toolCalls: string[]; content?: unknown; stream: boolean }) => {
    debug.event(trace.missionId, "model", `${trace.purpose}: ${modelId} ${input.finish?.unified ?? "finished"}`, {
      ...base,
      stream: input.stream,
      ms: Date.now() - input.started,
      stop: input.finish?.unified,
      ...(input.finish?.raw ? { stopRaw: input.finish.raw } : {}),
      usage: usageForLog(input.usage),
      ...(input.toolCalls.length ? { toolCalls: input.toolCalls } : {}),
      ...(traceVerbose() ? { prompt: promptForLog(input.params.prompt), tools: input.params.tools?.map((t) => t.name), output: input.content } : {}),
    });
  };
  const failed = (started: number, error: unknown, stream: boolean) =>
    debug.event(trace.missionId, "model", `${trace.purpose}: ${modelId} failed`, { ...base, stream, ms: Date.now() - started, error: errorMessage(error) }, "error");
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate, params }) {
      const started = Date.now();
      try {
        const result = await doGenerate();
        finished({
          started,
          params,
          finish: result.finishReason,
          usage: result.usage,
          toolCalls: result.content.flatMap((p) => (p.type === "tool-call" ? [p.toolName] : [])),
          content: contentForLog(result.content),
          stream: false,
        });
        return result;
      } catch (error) {
        failed(started, error, false);
        throw error;
      }
    },
    async wrapStream({ doStream, params }) {
      const started = Date.now();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        failed(started, error, true);
        throw error;
      }
      const toolCalls: string[] = [];
      let text = "";
      let logged = false;
      const watch = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "tool-call") toolCalls.push(part.toolName);
          else if (part.type === "text-delta" && traceVerbose()) text += part.delta;
          else if (part.type === "error") failed(started, part.error, true);
          else if (part.type === "finish" && !logged) {
            logged = true;
            finished({ started, params, finish: part.finishReason, usage: part.usage, toolCalls, content: text, stream: true });
          }
          controller.enqueue(part);
        },
        flush() {
          // Aborted mid-stream: no finish part arrived.
          if (!logged) debug.event(trace.missionId, "model", `${trace.purpose}: ${modelId} ended without finishing`, { ...base, stream: true, ms: Date.now() - started, ...(toolCalls.length ? { toolCalls } : {}) }, "warn");
        },
      });
      return { ...result, stream: result.stream.pipeThrough(watch) };
    },
  };
}

/** Every model call made through these models is traced to `debug` under the caller's mission and purpose. */
export function tracedModels(models: AgentModels, debug: DebugLog): AgentModels {
  const wrap = (role: "design" | "fast") => async (ownerId: string, trace: ModelTrace) => {
    try {
      const resolved = await models[role](ownerId, trace);
      // The AI SDK accepts a model id string too; only provider models (the only kind models.ts builds) can be wrapped.
      if (typeof resolved.model === "string") return resolved;
      return { ...resolved, model: wrapLanguageModel({ model: resolved.model, middleware: modelMiddleware(debug, trace, resolved.modelId, resolved.credential) }) };
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
