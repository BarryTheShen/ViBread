import { notifyManager, type QueryClient } from "@tanstack/react-query";
import type { MissionDetail, MissionSummary } from "@vibread/core";
import { DefaultChatTransport, type UIMessage } from "ai";
import { api, errorFromResponse, getJson } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";

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
 * The mission's busy flag in the cached mission detail (header "Claude is working… · Stop") and missions list (sidebar
 * "Designing…"). In-flight polls are cancelled first: one that left before the server took the message would land after
 * this and put the old flag back. Both writes notify in one batch, so header and sidebar change in the same render.
 */
async function setCachedBusy(queryClient: QueryClient, missionId: string, busy: boolean): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.mission(missionId), exact: true }),
    queryClient.cancelQueries({ queryKey: queryKeys.missions, exact: true }),
  ]);
  notifyManager.batch(() => {
    queryClient.setQueryData<MissionDetail>(queryKeys.mission(missionId), (detail) => detail && { ...detail, agentBusy: busy });
    queryClient.setQueryData<MissionSummary[]>(queryKeys.missions, (list) => list?.map((m) => (m.id === missionId ? { ...m, agentBusy: busy } : m)));
  });
}

/**
 * The mission chat's server contract as an AI SDK transport:
 *  - send: POST /api/missions/:id/chat { message } → AI SDK UI message stream (the server keeps the history)
 *  - resume: GET /api/missions/:id/chat/stream → the active run's stream, 204 when nothing runs
 *
 * Sending a message (typed, an ask_user choice, the brief) starts a run, so the mission shows as busy at once — the
 * mission detail and list are polled every few seconds and would otherwise say so only on their next poll. Once the
 * server has taken the message both are refetched (it reports the run from then on); a refused or failed send puts the
 * flag back and the chat shows the error.
 */
export function createMissionTransport(missionId: string, queryClient: QueryClient): DefaultChatTransport<UIMessage> {
  const chatPath = api.chatPath(missionId);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.mission(missionId), exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.missions, exact: true });
  };
  const sendFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method !== "POST") return missionFetch(input, init);
    await setCachedBusy(queryClient, missionId, true);
    try {
      const res = await missionFetch(input, init);
      refresh();
      return res;
    } catch (error) {
      await setCachedBusy(queryClient, missionId, false);
      // Query observers are notified on a zero timeout; let the page render "not busy" before the chat shows the error.
      // Otherwise the thread sees busy → idle only after the error, takes it for a run that ended and reloads the saved
      // history over your refused answer (or tries to follow a run that never started, which clears the error).
      await new Promise((resolve) => setTimeout(resolve, 0));
      refresh();
      throw error;
    }
  };
  return new DefaultChatTransport<UIMessage>({
    api: chatPath,
    fetch: sendFetch,
    prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) }, headers: { accept: "text/event-stream" } }),
    prepareReconnectToStreamRequest: () => ({ api: `${chatPath}/stream`, headers: { accept: "text/event-stream" } }),
  });
}

/** GET /api/missions/:id/chat: the saved conversation (AI SDK UIMessage[]). */
export function fetchChatHistory(missionId: string, signal?: AbortSignal): Promise<UIMessage[]> {
  return getJson<UIMessage[]>(api.chatPath(missionId), signal);
}
