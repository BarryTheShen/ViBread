import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { ChatBox, ChatMessageInlineMeta, type ChatMessageInlineMetaProps } from "@mui/x-chat";
import { useChat, useChatStore, useMessageContext, type ChatPartRendererMap } from "@mui/x-chat/headless";
import { processStream } from "@mui/x-chat-headless/stream";
import type { ApprovalView, Channel, MissionDetail, PermissionMode, TimelineEvent } from "@vibread/core";
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.js";
import { RecordedChip } from "../components/RecordedChip.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { Composer } from "./Composer.js";
import { createMissionChatAdapter, type MissionChatAdapter } from "./missionAdapter.js";
import { useMissionShell } from "./missionShell.js";
import { ChatThreadContext, useChatThread, type ChatThreadValue } from "./threadContext.js";
import { placeTimeline } from "./timeline.js";
import { TimelineRows } from "./TimelineRow.js";
import { ToolPartCard } from "./ToolPartCard.js";
import { recordedLabelOf } from "./uiMessages.js";
import { INTER_FONT, LORA_FONT } from "../theme.js";

/** Width of the conversation column (plan §3.2). */
export const CHAT_MAX_WIDTH = 760;

const partRenderers: ChatPartRendererMap = {
  tool: ({ part, message }) => <ToolPartCard invocation={part.toolInvocation} message={message} />,
  "dynamic-tool": ({ part, message }) => <ToolPartCard invocation={part.toolInvocation} message={message} />,
};

const SUGGESTIONS = ["Why did you pick these resistors?", "Make the LEDs fade instead of switching", "Explain the tests in simple words"];

const CHANNEL_NAMES: Record<Channel, string> = {
  web: "this app",
  imessage: "iMessage",
  mcp: "Claude Code",
  a2a: "another agent",
  system: "ViBread",
};

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

/**
 * A brand-new mission's run starts with the brief as the first user message (missions.create does not start a run).
 * Only for missions in BRIEF/CLARIFY with no revision: pre-warmed/seeded missions already have a design.
 */
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

/** Note at the top of a chat with no messages: the design came from somewhere other than this chat. */
function DesignOriginNotice({ channel, canChat }: { channel?: Channel; canChat: boolean }) {
  const origin = channel === "mcp" ? "Claude Code designed this over MCP." : channel === "a2a" ? "Another agent designed this." : undefined;
  // Without a Claude credential the agent can't answer, so never invite questions it can't take.
  const text = !canChat
    ? "Its checks, tests and build steps are ready — connect Claude in Settings to ask about it."
    : channel === "mcp"
      ? "Claude Code designed this over MCP — ask Claude anything about it here, or keep working from Claude Code."
      : channel === "a2a"
        ? "Another agent designed this — ask Claude anything about it."
        : "This design was prepared ahead of time — ask Claude anything about it.";
  return (
    <Stack role="note" direction="row" sx={{ gap: 1.5, alignItems: "flex-start", py: 1.5, px: 1 }}>
      <InfoOutlinedIcon fontSize="small" sx={{ color: "text.secondary", mt: 0.25 }} />
      <Box>
        {!canChat && origin && <Typography variant="body2">{origin}</Typography>}
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {text}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.25 }}>
          Here is what happened so far. Click a row to open it in the panel.
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * Default inline message meta plus a "Recorded run · …" chip on messages replayed from a recorded real-model run.
 */
function InlineMetaWithRecording(props: ChatMessageInlineMetaProps) {
  const { message } = useMessageContext();
  const recorded = recordedLabelOf(message?.metadata);
  return (
    <Stack direction="row" sx={{ gap: 1, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", fontFamily: INTER_FONT }}>
      {recorded && <RecordedChip label={recorded} />}
      <ChatMessageInlineMeta {...props} />
    </Stack>
  );
}

/** The thread has its own empty state (origin note + timeline rows) inside the list, so ChatBox's overlay stays empty. */
function NoEmptyState() {
  return null;
}

/**
 * `messageListContent` slot: the message rows (children, one per message id) with the mission's timeline rows merged
 * in between them in time order (chat/timeline.ts), then the rows after the last message and the mission-complete card.
 */
function ThreadContent({ children, ownerState: _ownerState, ...rest }: { children?: ReactNode; ownerState?: unknown } & Record<string, unknown>) {
  const { messages } = useChat();
  const { events, hasDesign, designChannel, canChat, afterMessages } = useChatThread();
  const { openPanel } = useMissionShell();
  const placed = useMemo(() => placeTimeline(messages, events), [messages, events]);
  const rows = Children.toArray(children);
  return (
    <Box {...rest} sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", px: 2, pt: 2, pb: 3, width: "100%", boxSizing: "border-box" }}>
      {rows.length === 0 && hasDesign && <DesignOriginNotice channel={designChannel} canChat={canChat} />}
      {rows.map((row) => {
        const id = isValidElement<{ id?: unknown }>(row) && typeof row.props.id === "string" ? row.props.id : undefined;
        const before = id ? placed.before[id] : undefined;
        return (
          <Box key={isValidElement(row) ? row.key : undefined}>
            {before && <TimelineRows items={before} onOpenPanel={openPanel} />}
            {row}
          </Box>
        );
      })}
      <TimelineRows items={placed.end} onOpenPanel={openPanel} />
      {afterMessages}
    </Box>
  );
}

/**
 * `composerRoot` slot: ViBread's own chat box (chat/Composer.tsx) wired to the MUI X Chat runtime, with approvals that
 * were requested outside this chat (iMessage, Claude Code, before this page loaded) pinned above it.
 */
function ComposerSlot() {
  const chat = useChat();
  const { missionId, detail } = useMissionShell();
  const { adapter, canChat, hasDesign, draft, setDraft, inputRef, mode, onModeChange } = useChatThread();
  const running = chat.isStreaming || detail.agentBusy;
  const inChat = new Set(
    chat.messages
      .flatMap((m) => m.parts)
      .flatMap((p) => ((p.type === "tool" || p.type === "dynamic-tool") && p.toolInvocation.approvalId ? [p.toolInvocation.approvalId] : [])),
  );
  const outside = detail.pendingApprovals.filter((a) => a.status === "pending" && !inChat.has(a.id));
  const awaitingDecision = chat.messages.some((m) => m.parts.some((p) => (p.type === "tool" || p.type === "dynamic-tool") && p.toolInvocation.state === "approval-requested"));
  const send = (text: string) => void chat.sendMessage({ parts: [{ type: "text", text }] });
  return (
    <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", width: "100%", px: 2, pb: 2, boxSizing: "border-box" }}>
      {outside.length > 0 && (
        <Box component="section" aria-label="Waiting for your decision" sx={{ maxHeight: "40vh", overflowY: "auto", mb: 1 }}>
          {outside.map((a: ApprovalView) => (
            <ApprovalCard
              key={a.id}
              approvalId={a.id}
              missionId={missionId}
              summary={a.summary}
              consequence={`${a.consequence} Requested by ${a.requestedBy.name ?? a.requestedBy.kind} (${CHANNEL_NAMES[a.requestedBy.channel]}).`}
              actionClass={a.actionClass}
              revisionHash={a.revisionHash}
              expiresAt={a.expiresAt}
              dense
              // The adapter posts the decision and the chat follows the resumed agent run.
              onDecide={async (decision) => void (await adapter.decide(a.id, decision))}
            />
          ))}
        </Box>
      )}
      {chat.error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => chat.setError(null)}>
          {chat.error.message}
        </Alert>
      )}
      {hasDesign && canChat && !running && outside.length === 0 && !awaitingDecision && !draft && (
        <Stack direction="row" sx={{ display: "flex", flexDirection: "row", gap: 1, flexWrap: "wrap", mb: 1 }} aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <Chip
              key={s}
              label={s}
              variant="outlined"
              clickable
              onClick={() => {
                setDraft(s);
                inputRef.current?.focus();
              }}
            />
          ))}
        </Stack>
      )}
      <Composer
        placeholder={hasDesign ? "Reply to Claude — ask why, or say what to change…" : "Reply to Claude…"}
        label="Message Claude"
        mode={mode}
        onModeChange={onModeChange}
        running={running}
        disabled={!canChat}
        disabledReason={canChat ? undefined : "Claude isn't connected, so it can't reply. Connect it in Settings — checks, tests and building still work."}
        onSend={send}
        onStop={() => {
          if (chat.isStreaming) chat.stopStreaming();
          else api.stopAgent(missionId).catch((error: unknown) => console.warn("Stop agent request failed", error));
        }}
        value={draft}
        onValueChange={setDraft}
        inputRef={inputRef}
      />
    </Box>
  );
}

export interface MissionChatProps {
  missionId: string;
  detail: MissionDetail;
  adapter: MissionChatAdapter;
  events: TimelineEvent[];
  canChat: boolean;
  mode: PermissionMode;
  onModeChange(mode: PermissionMode): void;
  /** Composer text, owned by the page so buttons elsewhere ("Ask Claude to redesign…") can prefill it. */
  draft: string;
  setDraft(text: string): void;
  inputRef: ChatThreadValue["inputRef"];
  afterMessages?: ReactNode;
}

/** The mission conversation: MUI X Chat thread + timeline rows + ViBread's chat box. */
export function MissionChat({ missionId, detail, adapter, events, canChat, mode, onModeChange, draft, setDraft, inputRef, afterMessages }: MissionChatProps) {
  const m = detail.mission;
  const hasDesign = m.currentRevision !== undefined;
  // The server moves a fresh mission BRIEF → CLARIFY on creation; either way no design exists yet.
  const isNewMission = (m.phase === "BRIEF" || m.phase === "CLARIFY") && m.currentRevision === undefined;
  const thread = useMemo<ChatThreadValue>(
    () => ({ adapter, events, canChat, hasDesign, designChannel: detail.revision?.author.channel, afterMessages, draft, setDraft, inputRef, mode, onModeChange }),
    [adapter, events, canChat, hasDesign, detail.revision?.author.channel, afterMessages, draft, setDraft, inputRef, mode, onModeChange],
  );
  return (
    <ChatThreadContext.Provider value={thread}>
      <ChatBox
        adapter={adapter}
        initialActiveConversationId={missionId}
        initialConversations={[{ id: missionId, title: "Mission chat" }]}
        partRenderers={partRenderers}
        features={{ conversationList: false, conversationHeader: false, attachments: false, suggestions: false, scrollToBottom: true }}
        slots={{ messageAvatar: null, messageInlineMeta: InlineMetaWithRecording, emptyState: NoEmptyState, composerRoot: ComposerSlot }}
        slotProps={{ messageList: { slots: { messageListContent: ThreadContent } } }}
        sx={{
          height: "100%",
          minHeight: 0,
          bgcolor: "transparent",
          border: 0,
          "& .MuiChatMessage-root": { maxWidth: "100%" },
          // Claude's replies: no bubble, the serif reading font (theme typography variant `reply`).
          "& .MuiChatMessage-roleAssistant .MuiChatMessage-bubble": { bgcolor: "transparent", color: "text.primary", px: 0, fontFamily: LORA_FONT, fontSize: "1.05rem", lineHeight: 1.7, maxWidth: "100%" },
          // Yours: a soft rounded bubble on the right.
          "& .MuiChatMessage-roleUser .MuiChatMessage-bubble": {
            bgcolor: "action.hover",
            color: "text.primary",
            borderRadius: "18px",
            px: 2,
            py: 1.25,
            fontSize: "1rem",
            lineHeight: 1.5,
          },
          "& .MuiChatMessage-roleUser .MuiChatMessage-inlineMeta": { color: "text.secondary" },
        }}
        localeText={{
          composerInputPlaceholder: "Reply to Claude…",
          composerInputAriaLabel: "Message Claude",
          messageAuthorAssistantLabel: "Claude",
          messageAuthorUserLabel: "You",
          threadNoMessagesLabel: "No conversation yet",
          threadNoMessagesHelperText: "Claude explains each step here. Ask it anything about your circuit.",
        }}
      >
        <ActiveRunFollower adapter={adapter} missionId={missionId} agentBusy={detail.agentBusy} />
        {isNewMission && <BriefKickoff adapter={adapter} brief={m.brief} agentBusy={detail.agentBusy} />}
      </ChatBox>
    </ChatThreadContext.Provider>
  );
}

export function useMissionChatAdapter(missionId: string): MissionChatAdapter {
  return useMemo(() => createMissionChatAdapter(missionId), [missionId]);
}
