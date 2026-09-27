import { Chat, useChat, type UseChatHelpers } from "@ai-sdk/react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, type EnrichedPartState } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import StopIcon from "@mui/icons-material/Stop";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Channel, MissionDetail, TimelineEvent } from "@vibread/core";
import type { UIMessage } from "ai";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Markdown from "react-markdown";
import { Link as RouterLink } from "react-router";
import remarkGfm from "remark-gfm";
import { api } from "../api/client.js";
import { RecordedChip } from "../components/RecordedChip.js";
import { INTER_FONT, LORA_FONT, MONO_FONT } from "../theme.js";
import { AskUserCard } from "./AskUserCard.js";
import { COMPOSER_FRAME_SX, SEND_BUTTON_SX, STOP_BUTTON_SX } from "./Composer.js";
import { useMissionShell } from "./missionShell.js";
import { createMissionTransport, fetchChatHistory } from "./missionTransport.js";
import { placeTimeline, type ChatTimeline } from "./timeline.js";
import { TimelineRows } from "./TimelineRow.js";
import { ToolRow } from "./ToolRow.js";
import { isErrorReply, isStoppedReply, recordedLabelOf } from "./uiMessages.js";

/** Width of the conversation column (plan §3.2). */
export const CHAT_MAX_WIDTH = 760;

const SUGGESTIONS = ["Why did you pick these resistors?", "Make the LEDs fade instead of switching", "Explain the tests in simple words"];

/** What the thread's message components need beyond assistant-ui's own state. */
interface ThreadValue {
  chat: UseChatHelpers<UIMessage>;
  placed: ChatTimeline;
  canChat: boolean;
  hasDesign: boolean;
  designChannel?: Channel;
  emptyInventory: boolean;
  afterMessages?: ReactNode;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Replies this browser cut off with Stop, before the saved history (which marks them too) is reloaded. */
  stoppedHere: ReadonlySet<string>;
  markStopped(messageId: string): void;
}

const ThreadContext = createContext<ThreadValue | null>(null);

function useThread(): ThreadValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error("useThread must be used inside MissionChat");
  return value;
}

/** Consecutive tool calls (except Claude's questions) share one collapsible "Worked on the design" row. */
const groupTools = (part: { type: string; toolName?: string }): readonly `group-${string}`[] | null =>
  part.type === "tool-call" && part.toolName !== "ask_user" ? ["group-tools"] : null;

// ---------- parts ----------

function ReplyMarkdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontFamily: LORA_FONT,
        fontSize: "1.05rem",
        lineHeight: 1.7,
        color: "text.primary",
        "& p": { my: 0.75 },
        "& ul, & ol": { my: 0.75, pl: 3 },
        "& code": { fontFamily: MONO_FONT, fontSize: "0.85em", bgcolor: "action.hover", px: 0.5, borderRadius: 0.5 },
        "& pre": { fontFamily: MONO_FONT, fontSize: 13, bgcolor: "action.hover", p: 1.5, borderRadius: 1, overflowX: "auto" },
        "& pre code": { bgcolor: "transparent", p: 0 },
        "& table": { borderCollapse: "collapse", fontFamily: INTER_FONT, fontSize: 14 },
        "& th, & td": { border: 1, borderColor: "divider", px: 1, py: 0.5 },
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </Box>
  );
}

/** `ask_user`: the run stops after it; answering (a choice or free text) sends a normal chat message. */
function AskUserPart({ args, result }: { args: unknown; result: unknown }) {
  const aui = useAui();
  const isLast = useAuiState((s) => s.message.isLast);
  const running = useAuiState((s) => s.thread.isRunning);
  return (
    <AskUserCard
      input={args}
      output={result}
      answerable={isLast && !running}
      onAnswer={(text) => aui.thread().append({ role: "user", content: [{ type: "text", text }] })}
    />
  );
}

/** The collapsible group row for consecutive tool calls; a single call renders as its own row. */
function ToolGroupRow({ count, running, children }: { count: number; running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (count <= 1) return <>{children}</>;
  return (
    <Box sx={{ my: 0.5, fontFamily: INTER_FONT }} data-tool-group="">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: 32, px: 1 }}>
        {running ? <CircularProgress size={16} aria-hidden /> : <TaskAltIcon fontSize="small" sx={{ color: "success.main" }} />}
        <Typography variant="body2" sx={{ fontWeight: 500 }} aria-live={running ? "polite" : undefined}>
          {running ? "Working on the design" : "Worked on the design"}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          · {count} steps
        </Typography>
        <IconButton
          size="small"
          aria-label={open ? "Hide steps" : "Show steps"}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          sx={{ minWidth: 28, minHeight: 28, color: "text.secondary" }}
        >
          <ChevronRightIcon fontSize="small" sx={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
        </IconButton>
      </Box>
      <Collapse in={open} id={id} unmountOnExit>
        <Box sx={{ pl: 2, borderLeft: 1, borderColor: "divider", ml: 2 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}

function renderAssistantPart({ part, children }: { part: EnrichedPartState | { type: `group-${string}`; counts: { running: number }; indices: readonly number[] } | { type: "indicator" }; children: ReactNode }): ReactNode {
  switch (part.type) {
    case "indicator":
      return (
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", px: 1, py: 0.5, color: "text.secondary", fontFamily: INTER_FONT }}>
          <CircularProgress size={14} aria-hidden />
          <Typography variant="body2">Claude is working…</Typography>
        </Stack>
      );
    case "text":
      return "text" in part && part.text ? <ReplyMarkdown text={part.text} /> : <></>;
    case "tool-call": {
      if (!("toolName" in part)) return <></>;
      if (part.toolName === "ask_user") return <AskUserPart args={part.args} result={part.isError ? undefined : part.result} />;
      return (
        <ToolRow toolName={part.toolName} toolCallId={part.toolCallId} args={part.args} result={part.result} isError={part.isError} status={part.status} approval={part.approval} />
      );
    }
    default:
      if (part.type.startsWith("group-") && "indices" in part) {
        return (
          <ToolGroupRow count={part.indices.length} running={part.counts.running > 0}>
            {children}
          </ToolGroupRow>
        );
      }
      // Reasoning, sources, files, data parts: not shown in the mission chat.
      return <></>;
  }
}

// ---------- messages ----------

function useRecordedLabel(): string | undefined {
  const { chat } = useThread();
  const id = useAuiState((s) => s.message.id);
  return recordedLabelOf(chat.messages.find((m) => m.id === id)?.metadata);
}

function UserText({ text }: { text: string }) {
  return <>{text}</>;
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  const { placed } = useThread();
  const { openPanel } = useMissionShell();
  const recorded = useRecordedLabel();
  const before = placed.before[id];
  return (
    <>
      {before && <TimelineRows items={before} onOpenPanel={openPanel} />}
      <MessagePrimitive.Root>
        <Stack sx={{ alignItems: "flex-end", my: 1.5, fontFamily: INTER_FONT }} data-role="user">
          <Box
            sx={{ maxWidth: "85%", bgcolor: "action.hover", color: "text.primary", borderRadius: "18px", px: 2, py: 1.25, fontSize: "1rem", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            <MessagePrimitive.Parts components={{ Text: UserText }} />
          </Box>
          {recorded && (
            <Box sx={{ mt: 0.5 }}>
              <RecordedChip label={recorded} />
            </Box>
          )}
        </Stack>
      </MessagePrimitive.Root>
    </>
  );
}

function AssistantMessage() {
  const recorded = useRecordedLabel();
  const { chat, stoppedHere } = useThread();
  const id = useAuiState((s) => s.message.id);
  const metadata = chat.messages.find((m) => m.id === id)?.metadata;
  const stopped = stoppedHere.has(id) || isStoppedReply(metadata);
  // The server's saved "couldn't start" reply is the error: one alert, not its text plus the send error's copy of it.
  const failedStart = isErrorReply(metadata);
  const parts = (
    <MessagePrimitive.GroupedParts groupBy={groupTools} indicator="empty">
      {renderAssistantPart}
    </MessagePrimitive.GroupedParts>
  );
  return (
    <MessagePrimitive.Root>
      <Box sx={{ my: 1.5 }} data-role="assistant">
        <Typography variant="caption" sx={{ color: "text.secondary", fontFamily: INTER_FONT, px: 0 }}>
          Claude
        </Typography>
        {failedStart ? (
          <Alert severity="error" sx={{ mt: 0.5, "& p": { m: 0 } }}>
            {parts}
          </Alert>
        ) : (
          parts
        )}
        {stopped && (
          <Stack direction="row" sx={{ alignItems: "center", gap: 0.5, mt: 0.5, color: "text.secondary", fontFamily: INTER_FONT }}>
            <StopCircleOutlinedIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption" sx={{ fontFamily: INTER_FONT }}>
              Stopped
            </Typography>
          </Stack>
        )}
        {!failedStart && (
          <MessagePrimitive.Error>
            <MessageErrorText />
          </MessagePrimitive.Error>
        )}
        {recorded && (
          <Box sx={{ mt: 0.5 }}>
            <RecordedChip label={recorded} />
          </Box>
        )}
      </Box>
    </MessagePrimitive.Root>
  );
}

/** A reply that failed mid-way (the error belongs on Claude's reply, never under your message). */
function MessageErrorText() {
  const { chat } = useThread();
  const isLast = useAuiState((s) => s.message.isLast);
  const error = useAuiState((s) => (s.message.status?.type === "incomplete" && s.message.status.reason === "error" ? s.message.status.error : undefined));
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : isLast && chat.error ? chat.error.message : "Claude's reply didn't finish.";
  return (
    <Alert severity="error" sx={{ mt: 1 }}>
      {text}
    </Alert>
  );
}

// ---------- thread chrome ----------

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
    <Stack role="note" direction="row" sx={{ gap: 1.5, alignItems: "flex-start", py: 1.5, px: 1, fontFamily: INTER_FONT }}>
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

function EmptyInventoryHint() {
  return (
    <Stack role="note" direction="row" sx={{ gap: 1, alignItems: "center", px: 1, py: 0.5, color: "text.secondary", fontFamily: INTER_FONT }}>
      <InfoOutlinedIcon fontSize="small" />
      <Typography variant="body2">
        Your inventory is empty, so Claude has no parts listed for this mission.{" "}
        <Link component={RouterLink} to="/inventory">
          Add your parts
        </Link>
      </Typography>
    </Stack>
  );
}

function ThreadComposer() {
  const aui = useAui();
  const { missionId, detail } = useMissionShell();
  const { chat, canChat, hasDesign, inputRef, markStopped } = useThread();
  const empty = useAuiState((s) => s.composer.isEmpty);
  // A failed reply shows its error on the reply itself; only an error with no reply to hang it on shows here.
  const lastIsAssistant = useAuiState((s) => s.thread.messages.at(-1)?.role === "assistant");
  const streaming = chat.status === "submitted" || chat.status === "streaming";
  const running = streaming || detail.agentBusy;
  const disabledReason = canChat ? undefined : "Claude isn't connected, so it can't reply. Connect it in Settings — checks, tests and building still work.";
  const stop = () => {
    if (streaming) {
      // This browser stops reading at once, so the server's own stopped mark on the reply never arrives on this stream.
      const reply = chat.messages.at(-1);
      if (reply?.role === "assistant") markStopped(reply.id);
      void chat.stop();
    }
    api.stopAgent(missionId).catch((error: unknown) => console.warn("Stop request failed", error));
  };
  return (
    <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", width: "100%", px: 2, pb: 2, boxSizing: "border-box", bgcolor: "background.default", fontFamily: INTER_FONT }}>
      {chat.error && !lastIsAssistant && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => chat.clearError()}>
          {chat.error.message}
        </Alert>
      )}
      {hasDesign && canChat && !running && empty && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mb: 1 }} aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <Chip
              key={s}
              label={s}
              variant="outlined"
              clickable
              onClick={() => {
                aui.composer().setText(s);
                inputRef.current?.focus();
              }}
            />
          ))}
        </Stack>
      )}
      <ComposerPrimitive.Root>
        <Paper variant="outlined" sx={COMPOSER_FRAME_SX}>
          <Box
            sx={{
              "& textarea": {
                width: "100%",
                resize: "none",
                border: 0,
                outline: "none",
                bgcolor: "transparent",
                color: "text.primary",
                font: "inherit",
                fontSize: "1rem",
                lineHeight: 1.5,
                p: 0,
                "&::placeholder": { color: "text.secondary", opacity: 1 },
              },
            }}
          >
            <ComposerPrimitive.Input
              ref={inputRef}
              placeholder={hasDesign ? "Reply to Claude — ask why, or say what to change…" : "Reply to Claude…"}
              aria-label="Message Claude"
              disabled={!canChat}
              minRows={1}
              maxRows={12}
              maxLength={4000}
            />
          </Box>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 1 }}>
            <Box sx={{ flex: 1 }} />
            {running ? (
              <Tooltip title="Stop Claude">
                <IconButton aria-label="Stop Claude" onClick={stop} sx={STOP_BUTTON_SX}>
                  <StopIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title={disabledReason ?? "Send (Enter) · new line: Shift+Enter"}>
                <span>
                  <ComposerPrimitive.Send asChild>
                    <IconButton aria-label="Send" sx={SEND_BUTTON_SX}>
                      <ArrowUpwardIcon fontSize="small" />
                    </IconButton>
                  </ComposerPrimitive.Send>
                </span>
              </Tooltip>
            )}
          </Stack>
        </Paper>
      </ComposerPrimitive.Root>
      {disabledReason && (
        <Typography variant="caption" component="p" sx={{ mt: 0.75, px: 1, color: "text.secondary" }}>
          {disabledReason}
        </Typography>
      )}
    </Box>
  );
}

function Thread() {
  const { placed, hasDesign, designChannel, canChat, emptyInventory, afterMessages } = useThread();
  const { openPanel } = useMissionShell();
  const messageCount = useAuiState((s) => s.thread.messages.length);
  return (
    <ThreadPrimitive.Root style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ThreadPrimitive.Viewport style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <Box sx={{ maxWidth: CHAT_MAX_WIDTH, mx: "auto", px: 2, pt: 2, pb: 3, width: "100%", boxSizing: "border-box", flex: 1 }} role="log" aria-label="Mission chat">
          {emptyInventory && <EmptyInventoryHint />}
          {messageCount === 0 && hasDesign && <DesignOriginNotice channel={designChannel} canChat={canChat} />}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <TimelineRows items={placed.end} onOpenPanel={openPanel} />
          {afterMessages}
        </Box>
        <ThreadPrimitive.ViewportFooter style={{ position: "sticky", bottom: 0 }}>
          <ThreadComposer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

/** Buttons elsewhere (panel: "Ask Claude to redesign without it", "Fix and retest") prefill the chat box. */
function AskAgentListener({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const aui = useAui();
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = e instanceof CustomEvent && typeof e.detail?.text === "string" ? e.detail.text : "";
      if (!text) return;
      aui.composer().setText(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("vibread:ask-agent", onAsk);
    return () => window.removeEventListener("vibread:ask-agent", onAsk);
  }, [aui, inputRef]);
  return null;
}

// ---------- runtime ----------

export interface MissionChatProps {
  missionId: string;
  detail: MissionDetail;
  events: TimelineEvent[];
  canChat: boolean;
  /** Focus target for "tell Claude" buttons (mission-complete card). */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  afterMessages?: ReactNode;
}

export interface MissionThreadProps extends Omit<MissionChatProps, "missionId"> {
  /** The AI SDK chat for this mission (its transport speaks the mission chat contract; see missionTransport.ts). */
  chat: Chat<UIMessage>;
  /** Messages the chat was created with (the saved history). */
  history: UIMessage[];
  reloadHistory(): Promise<UIMessage[] | undefined>;
}

/** The mission thread over an existing AI SDK chat: runtime, run following, brief kickoff, messages and chat box. */
export function MissionThread({ chat: instance, history, reloadHistory, detail, events, canChat, inputRef, afterMessages }: MissionThreadProps) {
  // `resume`: after a refresh during a run, pick up the active run's stream (the server answers 204 when none runs).
  const chat = useChat<UIMessage>({ chat: instance, resume: true });
  const runtime = useAISDKRuntime(chat);
  const m = detail.mission;
  const busy = detail.agentBusy;
  const streaming = chat.status === "submitted" || chat.status === "streaming";
  const [stoppedHere, setStoppedHere] = useState<ReadonlySet<string>>(() => new Set());
  const markStopped = useCallback((messageId: string) => setStoppedHere((ids) => new Set(ids).add(messageId)), []);
  const queryClient = useQueryClient();
  const invalidateMissions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["missions"] });
  }, [queryClient]);
  const wasStreaming = useRef(streaming);
  const askUserCount = useMemo(
    () =>
      chat.messages.reduce(
        (count, message) =>
          count +
          message.parts.filter((part) => typeof part === "object" && part !== null && "toolName" in part && part.toolName === "ask_user").length,
        0,
      ),
    [chat.messages],
  );
  const previousAskUserCount = useRef(0);
  useEffect(() => {
    if (askUserCount > previousAskUserCount.current) invalidateMissions();
    previousAskUserCount.current = askUserCount;
  }, [askUserCount, invalidateMissions]);

  // Runs this browser did not start (iMessage, Claude Code): follow the active stream while the server says busy, and
  // take the saved history as the truth once such a run ends.
  const wasBusy = useRef(busy);
  const lastFollow = useRef(0);
  useEffect(() => {
    if (busy && !streaming && Date.now() - lastFollow.current > 3_000) {
      lastFollow.current = Date.now();
      void chat.resumeStream();
    }
    if (wasBusy.current && !busy && !streaming) {
      void reloadHistory().then((saved) => {
        if (!saved) return;
        chat.setMessages(saved);
        setStoppedHere(new Set()); // the saved replies carry the server's own stopped mark
      });
    }
    // A send from this browser updates the list itself (missionTransport.ts); refetching as it starts could race the POST
    // and briefly put "Waiting for you" back. Runs started elsewhere show up here as busy while not streaming.
    if ((wasBusy.current !== busy && !streaming) || (wasStreaming.current && !streaming)) invalidateMissions();
    wasBusy.current = busy;
    wasStreaming.current = streaming;
  }, [busy, streaming, chat, invalidateMissions, reloadHistory]);

  // A brand-new mission's run starts with the brief as the first message (creating a mission does not start a run).
  // The server moves a fresh mission BRIEF → CLARIFY on creation; either way no design exists yet.
  const kickedOff = useRef(false);
  const isNewMission = (m.phase === "BRIEF" || m.phase === "CLARIFY") && m.currentRevision === undefined;
  useEffect(() => {
    if (kickedOff.current || !isNewMission || history.length > 0 || busy || !m.brief.trim()) return;
    kickedOff.current = true;
    void chat.sendMessage({ text: m.brief });
  }, [isNewMission, history.length, busy, m.brief, chat]);

  const placed = useMemo(() => placeTimeline(chat.messages, events), [chat.messages, events]);
  const thread = useMemo<ThreadValue>(
    () => ({
      chat,
      placed,
      canChat,
      hasDesign: m.currentRevision !== undefined,
      designChannel: detail.revision?.author.channel,
      emptyInventory: m.inventory.length === 0 && (m.inventoryNotes?.length ?? 0) === 0,
      afterMessages,
      inputRef,
      stoppedHere,
      markStopped,
    }),
    [chat, placed, canChat, m.currentRevision, detail.revision?.author.channel, m.inventory.length, m.inventoryNotes?.length, afterMessages, inputRef, stoppedHere, markStopped],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadContext.Provider value={thread}>
        <AskAgentListener inputRef={inputRef} />
        <Thread />
      </ThreadContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/** The mission conversation: assistant-ui thread over the AI SDK chat, with timeline rows merged in and our MUI chat box. */
export function MissionChat(props: MissionChatProps) {
  const history = useQuery({
    queryKey: ["mission", props.missionId, "chat"],
    queryFn: ({ signal }) => fetchChatHistory(props.missionId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  if (history.isPending) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", height: "100%" }}>
        <CircularProgress aria-label="Loading the conversation" />
      </Box>
    );
  }
  if (history.isError) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" action={<Button onClick={() => void history.refetch()}>Retry</Button>}>
          Couldn't load the conversation: {history.error.message}
        </Alert>
      </Box>
    );
  }
  return <ChatRuntime key={props.missionId} {...props} history={history.data} reloadHistory={async () => (await history.refetch()).data} />;
}

function ChatRuntime({ missionId, history, ...props }: MissionChatProps & { history: UIMessage[]; reloadHistory(): Promise<UIMessage[] | undefined> }) {
  const queryClient = useQueryClient();
  const [chat] = useState(() => new Chat<UIMessage>({ id: missionId, transport: createMissionTransport(missionId, queryClient), messages: history }));
  return <MissionThread chat={chat} history={history} {...props} />;
}
