import type { ChatMessage, ChatMessagePart, ChatToolApproval, ChatToolInvocationState } from "@mui/x-chat/types";
import type { ActionClass, ApprovalDecision } from "@vibread/core";
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

/**
 * MUI X Chat's approval response carries only `approved` + `reason`; ViBread has three decisions. The decision rides in
 * `reason` so the runtime's optimistic `approval-responded` state and our POST /api/approvals body agree.
 */
export function approvalResponse(id: string, decision: ApprovalDecision): { id: string; approved: boolean; reason: ApprovalDecision } {
  return { id, approved: decision !== "deny", reason: decision };
}

export function decisionOf(input: { approved: boolean; reason?: string }): ApprovalDecision {
  if (!input.approved) return "deny";
  return input.reason === "approve-mission" ? "approve-mission" : "approve-once";
}

/** Approval card copy the agent streams as `message-metadata` (`{ vibread: { approvals: { [id]: … } } }`). */
export interface ApprovalMeta {
  summary: string;
  consequence: string;
  actionClass: ActionClass;
  revisionHash: string;
  expiresAt: string;
}

export function approvalMetaOf(metadata: unknown, approvalId: string): ApprovalMeta | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.vibread) || !isRecord(metadata.vibread.approvals)) return undefined;
  const entry = metadata.vibread.approvals[approvalId];
  if (!isRecord(entry) || typeof entry.summary !== "string" || typeof entry.consequence !== "string") return undefined;
  return {
    summary: entry.summary,
    consequence: entry.consequence,
    actionClass: typeof entry.actionClass === "string" ? (entry.actionClass as ActionClass) : "state-changing",
    revisionHash: typeof entry.revisionHash === "string" ? entry.revisionHash : "",
    expiresAt: typeof entry.expiresAt === "string" ? entry.expiresAt : "",
  };
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
const NAMED_TOOL_CHUNKS: Record<string, true> = { "tool-input-start": true, "tool-input-available": true, "tool-approval-request": true };

/**
 * Normalizes AI SDK UI-stream chunks for MUI X Chat's stream processor:
 * - AI SDK `message-metadata` carries `messageMetadata`; MUI X Chat reads `metadata` and merges it shallowly, so the
 *   `vibread.approvals` map is accumulated here to keep earlier approvals' card copy.
 * - AI SDK `tool-approval-request` carries only ids, and a run resumed after a reconnect can start mid-call; MUI X Chat
 *   copies `toolName`/`input` from these chunks as-is (creating a part without a name). They are filled in from the
 *   same call's earlier chunk or the loaded history (`registry`).
 */
export function normalizeChunks<T>(registry: ToolCallRegistry = new Map()): TransformStream<T, T> {
  let approvals: Record<string, unknown> = {};
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
      }
      if (isRecord(chunk) && chunk.type === "message-metadata" && "messageMetadata" in chunk && !("metadata" in chunk)) {
        const meta: unknown = chunk.messageMetadata;
        const merged: Record<string, unknown> = isRecord(meta) ? { ...meta } : {};
        if (isRecord(merged.vibread)) {
          const vibread = { ...merged.vibread };
          if (isRecord(vibread.approvals)) {
            approvals = { ...approvals, ...vibread.approvals };
            vibread.approvals = approvals;
          }
          merged.vibread = vibread;
        }
        // Same chunk with the field MUI X Chat reads; the union member is unchanged ("message-metadata").
        const normalized = { ...chunk, metadata: merged } as T;
        controller.enqueue(normalized);
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
