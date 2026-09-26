import BlockIcon from "@mui/icons-material/Block";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import HourglassTopIcon from "@mui/icons-material/HourglassTop";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useChat } from "@mui/x-chat/headless";
import type { ChatDynamicToolInvocation, ChatMessage, ChatToolInvocation } from "@mui/x-chat/types";
import { CONSOLE_IDS, CONSOLE_LABELS, type Verdict } from "@vibread/core";
import { useId, useState } from "react";
import { VerdictChip } from "../components/VerdictChip.js";
import { isRecord } from "../lib/guards.js";
import { INTER_FONT, MONO_FONT } from "../theme.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { useMissionShell } from "./missionShell.js";
import { useChatThread } from "./threadContext.js";
import { toolLabel } from "./toolLabels.js";
import { approvalMetaOf, approvalResponse, decisionOf, toolSummaryOf } from "./uiMessages.js";

type Invocation = ChatToolInvocation | ChatDynamicToolInvocation;
type Verdicts = Partial<Record<(typeof CONSOLE_IDS)[number], Verdict>>;

function verdictsOf(output: unknown): Verdicts | undefined {
  if (!isRecord(output) || !isRecord(output.verdicts)) return undefined;
  const verdicts: Verdicts = {};
  for (const id of CONSOLE_IDS) {
    const v = output.verdicts[id];
    if (v === "GO" || v === "NO-GO" || v === "PENDING" || v === "SKIPPED") verdicts[id] = v;
  }
  return verdicts;
}

function Json({ value }: { value: unknown }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        bgcolor: "action.hover",
        borderRadius: 1,
        fontFamily: MONO_FONT,
        fontSize: 12,
        maxHeight: 240,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

/** A tool call as a compact one-line row ("Checked the circuit ✓ · No problems") that expands to its details. */
export function ToolPartCard({ invocation, message }: { invocation: Invocation; message: ChatMessage }) {
  const { missionId, detail, openPanel } = useMissionShell();
  const { adapter } = useChatThread();
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  // MUI X Chat can create a tool part without its name when the part's first chunk arrives mid-stream (after a
  // reconnect); the adapter remembers the name from the stored history part with the same toolCallId.
  const toolName: string | undefined = invocation.toolName ?? adapter.toolNameOf(invocation.toolCallId);
  const label = toolLabel(toolName);

  if (toolName === "ask_user") return <AskUserCard invocation={invocation} message={message} />;

  if (invocation.state === "approval-requested" || (invocation.state === "approval-responded" && invocation.approvalId)) {
    const approvalId = invocation.approvalId ?? invocation.toolCallId;
    const meta = approvalMetaOf(message.metadata, approvalId);
    const view = detail.pendingApprovals.find((a) => a.id === approvalId);
    const summary = meta?.summary ?? view?.summary ?? (toolName ? `Claude wants to: ${toolName.replace(/_/g, " ")}` : "Claude wants your OK for its next step.");
    const consequence = meta?.consequence ?? view?.consequence ?? "It will continue as soon as you decide.";
    return (
      <ApprovalCard
        approvalId={approvalId}
        missionId={missionId}
        summary={summary}
        consequence={consequence}
        actionClass={meta?.actionClass ?? view?.actionClass ?? "state-changing"}
        revisionHash={meta?.revisionHash ?? view?.revisionHash}
        expiresAt={meta?.expiresAt ?? view?.expiresAt}
        decided={invocation.approval ? { decision: decisionOf(invocation.approval) } : undefined}
        onDecide={(decision) => chat.addToolApprovalResponse(approvalResponse(approvalId, decision))}
      />
    );
  }

  const running = invocation.state === "input-streaming" || invocation.state === "input-available";
  const summary = invocation.state === "output-available" ? toolSummaryOf(invocation.output) : undefined;
  // One source of truth: when the tool reports on the revision the mission detail describes, show the live console
  // reports (MissionDetail.consoles); older revisions keep the votes they got at the time.
  const outputRevision = isRecord(invocation.output) && typeof invocation.output.revision === "number" ? invocation.output.revision : undefined;
  const reported = invocation.state === "output-available" ? verdictsOf(invocation.output) : undefined;
  const live = reported !== undefined && outputRevision !== undefined && outputRevision === detail.revision?.n;
  const verdicts: Verdicts | undefined = live ? Object.fromEntries(detail.consoles.map((c) => [c.console, c.verdict])) : reported;
  const verdictList = verdicts ? Object.values(verdicts) : [];
  const verdictStatus =
    verdictList.length === 0 ? undefined : verdictList.every((v) => v === "GO") ? "all GO" : `${verdictList.filter((v) => v === "GO").length} of ${verdictList.length} GO`;
  const status =
    invocation.state === "output-available"
      ? { icon: <CheckCircleOutlineIcon fontSize="small" sx={{ color: "success.main" }} />, text: label.done, word: verdictStatus ?? summary }
      : invocation.state === "output-error"
        ? {
            icon: <ErrorOutlineIcon fontSize="small" sx={{ color: "error.main" }} />,
            text: `Couldn't finish: ${label.active.replace(/…$/, "").replace(/^\w/, (c) => c.toLowerCase())}`,
            word: "failed",
          }
        : invocation.state === "output-denied"
          ? { icon: <BlockIcon fontSize="small" sx={{ color: "warning.main" }} />, text: label.active.replace(/…$/, ""), word: "not allowed" }
          : invocation.state === "approval-responded"
            ? { icon: <HourglassTopIcon fontSize="small" sx={{ color: "info.main" }} />, text: label.active, word: "continuing" }
            : { icon: <CircularProgress size={16} aria-hidden />, text: label.active, word: undefined };
  const opensPanel = outputRevision !== undefined && (toolName === "propose_design" || verdictList.length > 0);

  return (
    <Box sx={{ my: 0.25, fontFamily: INTER_FONT }} data-tool={toolName ?? "unknown"}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: 32, px: 1 }}>
        {status.icon}
        <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }} aria-live={running ? "polite" : undefined}>
          {status.text}
        </Typography>
        {status.word && (
          <Typography variant="body2" noWrap sx={{ color: "text.secondary", minWidth: 0, flexShrink: 1 }}>
            · {status.word}
          </Typography>
        )}
        {opensPanel && (
          <Button size="small" onClick={() => openPanel(verdictList.length > 0 ? "checks" : "schematic", { revision: outputRevision })} sx={{ flexShrink: 0 }}>
            Open r{outputRevision}
          </Button>
        )}
        <IconButton
          size="small"
          aria-label={open ? "Hide details" : "Show details"}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          sx={{ minWidth: 28, minHeight: 28, color: "text.secondary", flexShrink: 0 }}
        >
          <ChevronRightIcon fontSize="small" sx={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
        </IconButton>
      </Box>
      {invocation.state === "output-error" && invocation.errorText && (
        <Alert severity="error" sx={{ mt: 0.5 }}>
          {invocation.errorText}
        </Alert>
      )}
      {invocation.state === "output-denied" && (
        <Typography variant="body2" sx={{ px: 1, color: "text.secondary" }}>
          {invocation.approval?.reason === "deny" || !invocation.approval?.reason ? "You said no, so Claude skipped this step." : invocation.approval.reason}
        </Typography>
      )}
      <Collapse in={open} id={detailsId} unmountOnExit>
        <Stack sx={{ gap: 1, mt: 0.5, mb: 1, pl: 4.5, pr: 1 }}>
          {summary && <Typography variant="body2">{summary}</Typography>}
          {verdicts && Object.keys(verdicts).length > 0 && (
            <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              {!live && outputRevision !== undefined && (
                <Typography variant="caption" sx={{ color: "text.secondary", width: "100%" }}>
                  Votes for design r{outputRevision} at the time:
                </Typography>
              )}
              {CONSOLE_IDS.filter((id) => verdicts[id]).map((id) => (
                <Stack key={id} direction="row" sx={{ gap: 0.5, alignItems: "center" }}>
                  <Typography variant="caption">{CONSOLE_LABELS[id]}</Typography>
                  <VerdictChip verdict={verdicts[id]} />
                </Stack>
              ))}
            </Stack>
          )}
          <Typography variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary" }}>
            tool {toolName ?? "unknown"} · call {invocation.toolCallId}
          </Typography>
          {invocation.input !== undefined && (
            <>
              <Typography variant="caption">What Claude asked for</Typography>
              <Json value={invocation.input} />
            </>
          )}
          {invocation.state === "output-available" && (
            <>
              <Typography variant="caption">What came back</Typography>
              <Json value={invocation.output} />
            </>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

/** `ask_user` (agent-only): the run stops after it; the question is shown with quick replies. */
function AskUserCard({ invocation, message }: { invocation: Invocation; message: ChatMessage }) {
  const chat = useChat();
  const input = isRecord(invocation.input) ? invocation.input : {};
  const question = typeof input.question === "string" ? input.question : "Claude has a question for you.";
  const choices = Array.isArray(input.choices) ? input.choices.filter((c): c is string => typeof c === "string") : [];
  const isLatest = chat.messages[chat.messages.length - 1]?.id === message.id;
  return (
    <Paper variant="outlined" sx={{ my: 1, p: 1.5, borderRadius: "12px", fontFamily: INTER_FONT }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
        <HelpOutlineIcon color="primary" fontSize="small" />
        <Typography variant="body2" sx={{ color: "primary.main", fontWeight: 600 }}>
          Question for you
        </Typography>
      </Stack>
      <Typography variant="body1">{question}</Typography>
      {choices.length > 0 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: 1 }}>
          {choices.map((choice) => (
            <Button
              key={choice}
              variant="outlined"
              disabled={!isLatest || chat.isStreaming}
              onClick={() => void chat.sendMessage({ parts: [{ type: "text", text: choice }] })}
            >
              {choice}
            </Button>
          ))}
        </Stack>
      )}
      {isLatest && (
        <Typography variant="caption" sx={{ display: "block", mt: 1, color: "text.secondary" }}>
          {choices.length > 0 ? "Pick one, or type your own answer below." : "Type your answer below."}
        </Typography>
      )}
    </Paper>
  );
}
