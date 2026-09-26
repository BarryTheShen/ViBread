import { Type, hasApi, type AssistantMessage, type ImageContent, type Message, type TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ClaudeCallOptions, ClaudeModel } from "./models.js";

/** Requests per structured answer: the first try plus one repair round that shows Claude what was wrong. */
const MAX_ATTEMPTS = 2;
/** Longest raw answer kept on the error (the debug log caps it again). */
const RAW_LIMIT = 20_000;

/** Claude's structured answer couldn't be used; `raw` is what Claude sent (for the debug log, never the chat). */
export class StructuredAnswerError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StructuredAnswerError";
  }
}

/**
 * Claude sometimes sends a nested object or array of a large tool input as a JSON string. Parses such strings back
 * (recursively) so the schema sees the structure Claude meant.
 */
function unstringify(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return unstringify(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(unstringify);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unstringify(v)]));
  return value;
}

/** Whether this model can answer with thinking off — the only way Anthropic accepts a forced tool choice. */
function canForceTool(claude: ClaudeModel): boolean {
  const { model } = claude;
  const managedEffort = hasApi(model, "anthropic-messages") && model.compat?.supportsMidConvoEffort === true;
  return model.thinkingLevelMap?.off !== null && !managedEffort;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; problem: string; retry: Message[] };

function judge<T>(reply: AssistantMessage, name: string, schema: z.ZodType<T>): Attempt<T> {
  const call = reply.content.find((part) => part.type === "toolCall" && part.name === name);
  if (reply.stopReason === "length") {
    return { ok: false, problem: "Claude's answer was cut off at its output limit", retry: call?.type === "toolCall" ? [toolError(call.id, name, "Your answer was cut off at the output limit. Send a shorter complete answer.")] : [nudge(name, "Your answer was cut off. Send a shorter complete answer.")] };
  }
  if (call?.type !== "toolCall") {
    return { ok: false, problem: `Claude answered in text instead of calling ${name}`, retry: [nudge(name, `Answer only by calling the ${name} tool.`)] };
  }
  const direct = schema.safeParse(call.arguments);
  if (direct.success) return { ok: true, value: direct.data };
  const repaired = schema.safeParse(unstringify(call.arguments));
  if (repaired.success) return { ok: true, value: repaired.data };
  const issues = z.prettifyError(direct.error);
  return { ok: false, problem: `Claude's ${name} didn't match the expected format: ${issues.split("\n").slice(0, 6).join("; ")}`, retry: [toolError(call.id, name, `Your ${name} didn't match the schema:\n${issues}\nCall ${name} again with the complete corrected answer.`)] };
}

function toolError(toolCallId: string, toolName: string, text: string): Message {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: true, timestamp: Date.now() };
}

function nudge(name: string, text: string): Message {
  return { role: "user", content: `${text} (${name})`, timestamp: Date.now() };
}

/**
 * One structured Claude answer (test author, RETRO, photo check, scan): the answer schema is offered as the only tool and
 * Claude calls it; its arguments are the answer, checked by the zod schema. Thinking is turned off so the tool can be
 * required (models that always think get the tool offered with an instruction instead). An answer that is cut off, sent
 * as text, or fails the schema gets one repair round with the problem shown to Claude; after that StructuredAnswerError.
 */
export async function completeObject<T>(
  claude: ClaudeModel,
  input: {
    system: string;
    content: string | (TextContent | ImageContent)[];
    schema: z.ZodType<T>;
    name: string;
    description?: string;
  } & Pick<ClaudeCallOptions, "effort" | "signal">,
): Promise<T> {
  const tool = {
    name: input.name,
    description: input.description ?? `Return the ${input.name.replace(/_/g, " ")}.`,
    parameters: Type.Unsafe(z.toJSONSchema(input.schema, { io: "input", target: "draft-7", unrepresentable: "any" })),
  };
  const forced = canForceTool(claude);
  const options: ClaudeCallOptions = forced
    ? { toolChoice: { type: "tool", name: input.name }, thinkingEnabled: false }
    : { toolChoice: "auto", ...(input.effort ? { effort: input.effort } : {}) };
  const system = forced ? input.system : `${input.system}\n\nAnswer only by calling the ${input.name} tool.`;
  const messages: Message[] = [{ role: "user", content: input.content, timestamp: Date.now() }];
  let last: Attempt<T> | undefined;
  let raw = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const reply = await claude.complete({ systemPrompt: system, messages, tools: [tool] }, { ...options, ...(input.signal ? { signal: input.signal } : {}) });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? `Claude's ${input.name} request ${reply.stopReason === "aborted" ? "was stopped" : "failed"}.`);
    }
    raw = JSON.stringify(reply.content).slice(0, RAW_LIMIT);
    last = judge(reply, input.name, input.schema);
    if (last.ok) return last.value;
    messages.push(reply, ...last.retry);
  }
  throw new StructuredAnswerError(last && !last.ok ? last.problem : `Claude sent no ${input.name}`, raw);
}
