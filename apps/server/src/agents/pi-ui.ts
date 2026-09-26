import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, StopReason, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { getToolName, isToolUIPart, type FinishReason, type UIMessage, type UIMessageChunk } from "ai";
import { toolResultText } from "./pi-tools.js";

/**
 * The bridge between pi (the design agent's harness) and the chat contract the web consumes (AI SDK UI messages):
 * - `historyToPi`: the server-held UI history → the pi transcript for the next run (the UI history is the only record);
 * - `PiChunkTranslator`: pi agent events → AI SDK UI message chunks (text, tool parts, steps).
 */

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** A photo attached to a chat message (`data:image/…;base64,…`) as pi image content; undefined for anything else. */
export function imageOf(url: string): ImageContent | undefined {
  const match = DATA_URL.exec(url);
  if (!match || !match[1]!.startsWith("image/")) return undefined;
  return { type: "image", mimeType: match[1]!, data: match[2]! };
}

/** A user UI message as pi user content (text + photos); undefined when nothing is left. */
export function userContent(message: UIMessage): string | (TextContent | ImageContent)[] | undefined {
  const content: (TextContent | ImageContent)[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) content.push({ type: "text", text: part.text });
    else if (part.type === "file") {
      const image = imageOf(part.url);
      if (image) content.push(image);
    }
  }
  if (!content.length) return undefined;
  if (content.every((c) => c.type === "text")) return content.map((c) => (c as TextContent).text).join("\n");
  return content;
}

function asArguments(input: unknown): ToolCall["arguments"] {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as ToolCall["arguments"]) : {};
}

const STOPPED = "The run stopped before this tool finished.";

function toolResultOf(part: Parameters<typeof getToolName>[0], toolName: string): ToolResultMessage {
  const base = { role: "toolResult" as const, toolCallId: part.toolCallId, toolName, timestamp: Date.now() };
  if (part.state === "output-available") return { ...base, content: [{ type: "text", text: toolResultText(toolName, part.output) }], isError: false };
  const errorText = part.state === "output-error" ? part.errorText : part.state === "output-denied" ? "The tool call was denied." : STOPPED;
  return { ...base, content: [{ type: "text", text: errorText }], isError: true };
}

/**
 * One assistant UI message (every step of a run) → pi assistant turns, each followed by its tool results. A step ends at
 * a `step-start` part or when text follows tool calls. Turns are attributed to `model` so pi replays them as its own.
 */
function assistantTurns(message: UIMessage, model: Model<Api>): Message[] {
  const out: Message[] = [];
  let content: AssistantMessage["content"] = [];
  let results: ToolResultMessage[] = [];
  const flush = () => {
    if (content.length) {
      out.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: results.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      out.push(...results);
    }
    content = [];
    results = [];
  };
  for (const part of message.parts) {
    if (part.type === "step-start") flush();
    else if (part.type === "text") {
      if (results.length) flush();
      if (part.text.trim()) content.push({ type: "text", text: part.text });
    } else if (isToolUIPart(part)) {
      const toolName = getToolName(part);
      content.push({ type: "toolCall", id: part.toolCallId, name: toolName, arguments: asArguments(part.input) });
      results.push(toolResultOf(part, toolName));
    }
  }
  flush();
  return out;
}

/** The server-held chat history → the pi transcript (without the system prompt, which each run rebuilds). */
export function historyToPi(history: UIMessage[], model: Model<Api>): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    if (message.role === "user") {
      const content = userContent(message);
      if (content) out.push({ role: "user", content, timestamp: Date.now() });
    } else if (message.role === "assistant") out.push(...assistantTurns(message, model));
  }
  return out;
}

/** pi's stop reason → the AI SDK finish reason the web sees on `finish`. */
export const FINISH_REASONS: Record<StopReason, FinishReason> = {
  stop: "stop",
  length: "length",
  toolUse: "tool-calls",
  error: "error",
  aborted: "other",
  pending: "other",
  deferred: "other",
};

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
  return content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n") || "The tool failed.";
}

/**
 * pi agent events → AI SDK UI message chunks for one assistant UI message. Turn = step; text and thinking blocks are keyed
 * by turn + content index (providers may interleave blocks); tool calls stream their input, then their result.
 */
export class PiChunkTranslator {
  private turn = 0;
  /** Tool calls whose input the UI has; a tool that starts without one (no streamed call) gets it at execution. */
  private readonly announced = new Set<string>();
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly write: (chunk: UIMessageChunk) => void) {}

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.turn++;
        this.write({ type: "start-step" });
        return;
      case "turn_end":
        this.write({ type: "finish-step" });
        return;
      case "message_update":
        this.update(event.assistantMessageEvent);
        return;
      case "tool_execution_start":
        this.toolNames.set(event.toolCallId, event.toolName);
        if (!this.announced.has(event.toolCallId)) {
          this.announced.add(event.toolCallId);
          this.write({ type: "tool-input-available", toolCallId: event.toolCallId, toolName: event.toolName, input: event.args });
        }
        return;
      case "tool_execution_end":
        if (event.isError) this.write({ type: "tool-output-error", toolCallId: event.toolCallId, errorText: resultText(event.result) });
        else this.write({ type: "tool-output-available", toolCallId: event.toolCallId, output: (event.result as { details?: unknown }).details ?? resultText(event.result) });
        return;
      default:
        return;
    }
  }

  private id(contentIndex: number): string {
    return `${this.turn}-${contentIndex}`;
  }

  private update(event: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]): void {
    switch (event.type) {
      case "text_start":
        this.write({ type: "text-start", id: this.id(event.contentIndex) });
        return;
      case "text_delta":
        this.write({ type: "text-delta", id: this.id(event.contentIndex), delta: event.delta });
        return;
      case "text_end":
        this.write({ type: "text-end", id: this.id(event.contentIndex) });
        return;
      case "thinking_start":
        this.write({ type: "reasoning-start", id: this.id(event.contentIndex) });
        return;
      case "thinking_delta":
        this.write({ type: "reasoning-delta", id: this.id(event.contentIndex), delta: event.delta });
        return;
      case "thinking_end":
        this.write({ type: "reasoning-end", id: this.id(event.contentIndex) });
        return;
      case "toolcall_start": {
        const call = event.partial.content[event.contentIndex];
        if (call?.type !== "toolCall" || !call.id || !call.name) return;
        this.toolNames.set(call.id, call.name);
        this.write({ type: "tool-input-start", toolCallId: call.id, toolName: call.name });
        return;
      }
      case "toolcall_delta": {
        const call = event.partial.content[event.contentIndex];
        if (call?.type !== "toolCall" || !this.toolNames.has(call.id)) return;
        this.write({ type: "tool-input-delta", toolCallId: call.id, inputTextDelta: event.delta });
        return;
      }
      case "toolcall_end":
        this.toolNames.set(event.toolCall.id, event.toolCall.name);
        this.announced.add(event.toolCall.id);
        this.write({ type: "tool-input-available", toolCallId: event.toolCall.id, toolName: event.toolCall.name, input: event.toolCall.arguments });
        return;
      default:
        return;
    }
  }
}
