import { ChatBox } from "@mui/x-chat";
import { useChat, useChatStore, type ChatPartRendererMap } from "@mui/x-chat/headless";
import { processStream } from "@mui/x-chat-headless/stream";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMissionChatAdapter, type MissionChatAdapter } from "./missionAdapter.js";
import { ToolPartCard } from "./ToolPartCard.js";

const partRenderers: ChatPartRendererMap = {
  tool: ({ part, message }) => <ToolPartCard invocation={part.toolInvocation} message={message} />,
  "dynamic-tool": ({ part, message }) => <ToolPartCard invocation={part.toolInvocation} message={message} />,
};

const SUGGESTIONS = [
  "Why did you pick these resistors?",
  "Make the LEDs fade instead of switching",
  "Explain the tests in simple words",
];

/**
 * Streams runs this browser did not start: the continuation after an approval decision (from here or iMessage) and
 * runs started from iMessage / Claude Code. Uses GET chat/stream through the adapter and MUI X Chat's own stream
 * processor, so the parts land in the same assistant message as a normal send.
 */
function ActiveRunFollower({ adapter, missionId, agentBusy }: { adapter: MissionChatAdapter; missionId: string; agentBusy: boolean }) {
  const store = useChatStore();
  const chat = useChat();
  const following = useRef(false);
  const wasBusy = useRef(agentBusy);
  const lastAttempt = useRef(0);

  const follow = useMemo(
    () => async () => {
      if (following.current || store.state.isStreaming) return;
      following.current = true;
      lastAttempt.current = Date.now();
      const abort = new AbortController();
      try {
        await adapter.historyLoaded;
        if (store.state.isStreaming) return;
        store.setStreaming(true, missionId);
        store.setActiveStreamAbortController(abort);
        const stream = await adapter.reconnectToStream?.({ conversationId: missionId, signal: abort.signal });
        if (stream) await processStream(store, stream, { conversationId: missionId, signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) console.warn("Following the agent run failed", error);
      } finally {
        store.setActiveStreamAbortController(null);
        store.setStreaming(false);
        following.current = false;
      }
    },
    [adapter, missionId, store],
  );

  useEffect(() => adapter.onApprovalDecided(() => void follow()), [adapter, follow]);

  useEffect(() => {
    if (agentBusy && !chat.isStreaming && Date.now() - lastAttempt.current > 3_000) void follow();
    // A run finished that we did not (fully) watch: take the server's saved history as the truth.
    if (wasBusy.current && !agentBusy && !chat.isStreaming) void chat.reloadMessages();
    wasBusy.current = agentBusy;
  }, [agentBusy, chat, follow]);

  return null;
}

/** A new mission's run starts with the brief as the first user message (missions.create does not start a run). */
function BriefKickoff({ adapter, brief, agentBusy }: { adapter: MissionChatAdapter; brief: string; agentBusy: boolean }) {
  const chat = useChat();
  const [historyReady, setHistoryReady] = useState(false);
  const sent = useRef(false);
  useEffect(() => {
    let live = true;
    void adapter.historyLoaded.then(() => live && setHistoryReady(true));
    return () => {
      live = false;
    };
  }, [adapter]);
  useEffect(() => {
    if (!historyReady || sent.current || agentBusy || chat.isStreaming || chat.isLoadingHistory || chat.error) return;
    if (chat.messages.length > 0 || !brief.trim()) return;
    sent.current = true;
    void chat.sendMessage({ parts: [{ type: "text", text: brief }] });
  }, [historyReady, agentBusy, brief, chat]);
  return null;
}

/** Reports which approval ids already have a card in the chat, so the page shows only the others separately. */
function ApprovalIdsReporter({ onChange }: { onChange(ids: string[]): void }) {
  const { messages } = useChat();
  const key = messages
    .flatMap((m) => m.parts)
    .flatMap((p) => ((p.type === "tool" || p.type === "dynamic-tool") && p.toolInvocation.approvalId ? [p.toolInvocation.approvalId] : []))
    .join("\n");
  useEffect(() => onChange(key ? key.split("\n") : []), [key, onChange]);
  return null;
}

export function MissionChat({
  missionId,
  agentBusy,
  adapter,
  brief,
  hasDesign,
  onApprovalIdsChange,
}: {
  missionId: string;
  agentBusy: boolean;
  adapter: MissionChatAdapter;
  brief: string;
  /** Follow-up suggestions only make sense once a design exists. */
  hasDesign: boolean;
  onApprovalIdsChange(ids: string[]): void;
}) {
  return (
    <ChatBox
      adapter={adapter}
      initialActiveConversationId={missionId}
      initialConversations={[{ id: missionId, title: "Mission chat" }]}
      partRenderers={partRenderers}
      features={{ conversationList: false, conversationHeader: false, attachments: false, suggestions: hasDesign, scrollToBottom: true }}
      suggestions={hasDesign ? SUGGESTIONS : []}
      slots={{ messageAvatar: null }}
      sx={{ height: "100%", minHeight: 0, bgcolor: "transparent" }}
      localeText={{
        composerInputPlaceholder: "Tell the agent what to change, or ask why…",
        composerInputAriaLabel: "Message the agent",
        messageAuthorAssistantLabel: "ViBread agent",
        messageAuthorUserLabel: "You",
        threadNoMessagesLabel: "No conversation yet",
        threadNoMessagesHelperText: "The agent explains each step here. Ask it anything about your circuit.",
      }}
    >
      <ActiveRunFollower adapter={adapter} missionId={missionId} agentBusy={agentBusy} />
      <BriefKickoff adapter={adapter} brief={brief} agentBusy={agentBusy} />
      <ApprovalIdsReporter onChange={onApprovalIdsChange} />
    </ChatBox>
  );
}

export function useMissionChatAdapter(missionId: string): MissionChatAdapter {
  return useMemo(() => createMissionChatAdapter(missionId), [missionId]);
}
