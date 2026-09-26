import type { ChatMessage, ChatMessagePart, ChatToolApproval, ChatToolInvocationState } from "@mui/x-chat/types";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { isRecord } from "../lib/guards.js";

/**
 * Glue between the server's AI SDK `UIMessage` history (GET /api/missions/:id/chat) and MUI X Chat's `ChatMessage`
 * model. Part shapes differ only for tools: AI SDK uses `{ type: "tool-<name>", approval: { id } }`, MUI X Chat uses
 * `{ type: "tool", toolInvocation: { toolName, approvalId } }`.
 */

type UIPart = UIMessage["parts"][number];

function toolPart(part: UIPart): ChatMessagePart | null {
  if (!isToolUIPart(part)) return null;
  const approval: ChatToolApproval | undefined =
    part.approval && typeof part.approval.approved === "boolean"
      ? { approved: part.approval.approved, ...(part.approval.reason ? { reason: part.approval.reason } : {}) }
      : undefined;
  const invocation = {
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    state: part.state as ChatToolInvocationState,
    input: part.input,
    output: part.state === "output-available" ? part.output : undefined,
    errorText: part.state === "output-error" ? part.errorText : undefined,
    approvalId: part.approval?.id,
    approval,
    title: part.title,
    providerExecuted: part.providerExecuted,
  };
  return part.type === "dynamic-tool" ? { type: "dynamic-tool", toolInvocation: invocation } : { type: "tool", toolInvocation: invocation };
}

function chatPart(part: UIPart): ChatMessagePart | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text, state: part.state ?? "done" };
    case "reasoning":
      return { type: "reasoning", text: part.text, state: part.state ?? "done" };
    case "file":
      return { type: "file", mediaType: part.mediaType, url: part.url, filename: part.filename };
    case "source-url":
      return { type: "source-url", sourceId: part.sourceId, url: part.url, title: part.title };
    case "source-document":
      return { type: "source-document", sourceId: part.sourceId, title: part.title };
    case "step-start":
      return { type: "step-start" };
    default:
      break;
  }
  const tool = toolPart(part);
  if (tool) return tool;
  if (part.type.startsWith("data-") && "data" in part) {
    const data: unknown = part.data;
    return { type: part.type as `data-${string}`, id: "id" in part && typeof part.id === "string" ? part.id : undefined, data };
  }
  return null;
}

/** Server history → MUI X Chat messages. Unknown part kinds are dropped rather than rendered as raw JSON. */
export function toChatMessages(messages: UIMessage[], conversationId: string): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    conversationId,
    role: message.role,
    parts: message.parts.map(chatPart).filter((p): p is ChatMessagePart => p !== null),
    metadata: isRecord(message.metadata) ? message.metadata : undefined,
    status: "sent",
  }));
}

/** The composer's user message → the `{ message: UIMessage }` body POST /api/missions/:id/chat expects. */
export function toUserUiMessage(message: ChatMessage): UIMessage {
  const parts: UIMessage["parts"] = [];
  for (const part of message.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "file") parts.push({ type: "file", mediaType: part.mediaType, url: part.url, filename: part.filename });
  }
  return { id: message.id, role: "user", parts };
}

/** Mark on messages replayed from a recorded real-model run (`metadata.vibread.recorded`), never a live reply. */
export function recordedLabelOf(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.vibread) || !isRecord(metadata.vibread.recorded)) return undefined;
  const label = metadata.vibread.recorded.label;
  return typeof label === "string" ? label : undefined;
}

/** One-line result the agent tools always include (`{ summary }`). */
export function toolSummaryOf(output: unknown): string | undefined {
  return isRecord(output) && typeof output.summary === "string" ? output.summary : undefined;
}

/** Name + input of every tool call seen so far (loaded history and streamed chunks), keyed by toolCallId. */
export type ToolCallRegistry = Map<string, { toolName: string; input?: unknown; dynamic?: boolean }>;

/** Records the tool calls of loaded history, so later chunks for the same call can be completed. */
export function rememberToolCalls(messages: ChatMessage[], registry: ToolCallRegistry): void {
  for (const message of messages) {
    for (const part of message.parts) {
      if ((part.type !== "tool" && part.type !== "dynamic-tool") || !part.toolInvocation.toolName) continue;
      registry.set(part.toolInvocation.toolCallId, {
        toolName: part.toolInvocation.toolName,
        input: part.toolInvocation.input,
        dynamic: part.type === "dynamic-tool",
      });
    }
  }
}

/** Chunks MUI X Chat applies `toolName`/`input` from — a missing field overwrites the part's value with undefined. */
const NAMED_TOOL_CHUNKS: Record<string, true> = { "tool-input-start": true, "tool-input-available": true };

/**
 * Normalizes AI SDK UI-stream chunks for MUI X Chat's stream processor:
 * - AI SDK `message-metadata` carries `messageMetadata`; MUI X Chat reads `metadata`.
 * - A run resumed after a reconnect can start mid-call; MUI X Chat copies `toolName`/`input` from the part-creating
 *   chunks as-is (creating a part without a name when they lack one). They are filled in from the same call's earlier
 *   chunk or the loaded history (`registry`).
 */
export function normalizeChunks<T>(registry: ToolCallRegistry = new Map()): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (isRecord(chunk) && typeof chunk.toolCallId === "string" && typeof chunk.type === "string") {
        const known = registry.get(chunk.toolCallId);
        if (typeof chunk.toolName === "string") {
          registry.set(chunk.toolCallId, {
            toolName: chunk.toolName,
            input: chunk.input ?? known?.input,
            dynamic: chunk.dynamic === true || known?.dynamic === true,
          });
        } else if (known && NAMED_TOOL_CHUNKS[chunk.type]) {
          const completed = {
            ...chunk,
            toolName: known.toolName,
            ...(chunk.input === undefined && known.input !== undefined ? { input: known.input } : {}),
            ...(known.dynamic && chunk.dynamic === undefined ? { dynamic: true } : {}),
          } as T;
          controller.enqueue(completed);
          return;
        }
        // A call whose input failed the tool's schema ends with `tool-input-error` carrying that input, which MUI X Chat
        // drops (it sets only the error). Apply the input first, so e.g. an ask_user question still shows (issue #2).
        if (chunk.type === "tool-input-error" && chunk.input !== undefined) {
          const name = typeof chunk.toolName === "string" ? chunk.toolName : known?.toolName;
          controller.enqueue({ type: "tool-input-available", toolCallId: chunk.toolCallId, toolName: name, input: chunk.input, ...(chunk.dynamic === true ? { dynamic: true } : {}) } as T);
        }
      }
      if (isRecord(chunk) && chunk.type === "message-metadata" && "messageMetadata" in chunk && !("metadata" in chunk)) {
        // Same chunk with the field MUI X Chat reads; the union member is unchanged ("message-metadata").
        const normalized = { ...chunk, metadata: isRecord(chunk.messageMetadata) ? chunk.messageMetadata : {} } as T;
        controller.enqueue(normalized);
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
