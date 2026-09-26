import { createAiSdkAdapter } from "@mui/x-chat";
import type { ChatAdapter } from "@mui/x-chat/headless";
import type { ChatMessageChunk, ChatStreamEnvelope } from "@mui/x-chat/types";
import type { ApprovalDecision, ApprovalView } from "@vibread/core";
import type { UIMessage } from "ai";
import { api, apiFetch, getJson, HttpError } from "../api/client.js";
import { decisionOf, normalizeChunks, toChatMessages, toUserUiMessage } from "./uiMessages.js";

type ChunkStream = ReadableStream<ChatMessageChunk | ChatStreamEnvelope>;

export interface MissionChatAdapter extends ChatAdapter {
  /** Resolves once the first history load (GET chat) has completed, successfully or not. */
  readonly historyLoaded: Promise<void>;
  /** POST /api/approvals/:id, then notify followers (the server resumes the agent right after a decision). */
  decide(approvalId: string, decision: ApprovalDecision): Promise<ApprovalView>;
  /** Subscribe to approval decisions made from this browser. */
  onApprovalDecided(listener: (view: ApprovalView) => void): () => void;
}

const RESUME_PLACEHOLDER = { id: "vibread-resume", role: "user", parts: [] } as const;

/** Chat errors (AgentsCore contract) in words a beginner can act on. */
const FRIENDLY_ERRORS: Record<string, string> = {
  claude_not_connected: "Claude isn't connected, so the agent can't reply. Connect it in Settings.",
  agent_busy: "The agent is already working on this mission (maybe from iMessage or Claude Code). Wait for it, or press Stop agent.",
};

/**
 * Wraps MUI X Chat's `createAiSdkAdapter` (which decodes the AI SDK UI message stream, SSE framing included) with the
 * pieces the stock adapter lacks for ViBread's server-authored history:
 *  - `listMessages`: GET /api/missions/:id/chat (UIMessage[] → ChatMessage[])
 *  - `addToolApprovalResponse`: POST /api/approvals/:approvalId { decision } (the broker is the authority)
 *  - `stop`: POST /api/missions/:id/chat/stop (the runtime also aborts the open fetch)
 *  - `reconnectToStream`: GET /api/missions/:id/chat/stream (204 → null)
 */
export function createMissionChatAdapter(missionId: string): MissionChatAdapter {
  const chatPath = api.chatPath(missionId);
  const listeners = new Set<(view: ApprovalView) => void>();
  let markHistoryLoaded: () => void = () => {};
  const historyLoaded = new Promise<void>((resolve) => {
    markHistoryLoaded = resolve;
  });

  const sender = createAiSdkAdapter({
    stream: async ({ message, signal }) => {
      try {
        const res = await apiFetch(chatPath, {
          method: "POST",
          body: JSON.stringify({ message: toUserUiMessage(message) }),
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (!res.body) throw new Error("The server accepted the message but sent no reply stream.");
        return res.body;
      } catch (error) {
        if (error instanceof HttpError && error.code in FRIENDLY_ERRORS) throw new Error(FRIENDLY_ERRORS[error.code]);
        throw error;
      }
    },
  });

  async function openActiveStream(signal: AbortSignal): Promise<ChunkStream | null> {
    const res = await apiFetch(`${chatPath}/stream`, { headers: { accept: "text/event-stream" }, signal });
    if (res.status === 204 || !res.body) return null;
    const body = res.body;
    const decoder = createAiSdkAdapter({ stream: () => body });
    const stream = await decoder.sendMessage({ message: { ...RESUME_PLACEHOLDER, parts: [] }, messages: [], signal });
    return stream.pipeThrough(normalizeChunks<ChatMessageChunk | ChatStreamEnvelope>());
  }

  async function decide(approvalId: string, decision: ApprovalDecision): Promise<ApprovalView> {
    const view = await api.decideApproval(approvalId, decision);
    for (const listener of listeners) listener(view);
    return view;
  }

  return {
    historyLoaded,
    decide,
    onApprovalDecided(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listMessages({ conversationId }) {
      try {
        const history = await getJson<UIMessage[]>(chatPath);
        return { messages: toChatMessages(history, conversationId), hasMore: false };
      } finally {
        markHistoryLoaded();
      }
    },
    async sendMessage(input) {
      const stream = await sender.sendMessage(input);
      return stream.pipeThrough(normalizeChunks<ChatMessageChunk | ChatStreamEnvelope>());
    },
    reconnectToStream: ({ signal }) => openActiveStream(signal),
    async addToolApprovalResponse(input) {
      await decide(input.id, decisionOf(input));
    },
    stop() {
      api.stopAgent(missionId).catch((error: unknown) => console.warn("Stop agent request failed", error));
    },
  };
}
