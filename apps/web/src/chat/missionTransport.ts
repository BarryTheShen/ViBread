import { DefaultChatTransport, type UIMessage } from "ai";
import { api, errorFromResponse, getJson } from "../api/client.js";

/** Chat errors (server contract) in words a beginner can act on. */
const FRIENDLY_ERRORS: Record<string, string> = {
  claude_not_connected: "Claude isn't connected, so it can't reply. Connect it in Settings.",
  agent_busy: "Claude is already working on this mission (maybe from iMessage or Claude Code). Wait for it, or press Stop.",
};

/** fetch that turns the server's JSON errors into one readable message (AI SDK shows `error.message`). */
async function missionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "include", ...init });
  if (res.ok || res.status === 204) return res;
  const error = await errorFromResponse(res);
  throw new Error(FRIENDLY_ERRORS[error.code] ?? error.message);
}

/**
 * The mission chat's server contract as an AI SDK transport:
 *  - send: POST /api/missions/:id/chat { message } → AI SDK UI message stream (the server keeps the history)
 *  - resume: GET /api/missions/:id/chat/stream → the active run's stream, 204 when nothing runs
 */
export function createMissionTransport(missionId: string): DefaultChatTransport<UIMessage> {
  const chatPath = api.chatPath(missionId);
  return new DefaultChatTransport<UIMessage>({
    api: chatPath,
    fetch: missionFetch,
    prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) }, headers: { accept: "text/event-stream" } }),
    prepareReconnectToStreamRequest: () => ({ api: `${chatPath}/stream`, headers: { accept: "text/event-stream" } }),
  });
}

/** GET /api/missions/:id/chat: the saved conversation (AI SDK UIMessage[]). */
export function fetchChatHistory(missionId: string, signal?: AbortSignal): Promise<UIMessage[]> {
  return getJson<UIMessage[]>(api.chatPath(missionId), signal);
}
