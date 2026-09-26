import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import HourglassTopIcon from "@mui/icons-material/HourglassTop";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useChat } from "@mui/x-chat/headless";
import type { ChatDynamicToolInvocation, ChatMessage, ChatToolInvocation } from "@mui/x-chat/types";
import { CONSOLE_IDS, CONSOLE_LABELS, type Verdict } from "@vibread/core";
import { useId, useState } from "react";
import { VerdictChip } from "../components/VerdictChip.js";
import { isRecord } from "../lib/guards.js";
import { MONO_FONT } from "../theme.js";
import { useMissionContext } from "../workspace/missionContext.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { toolLabel } from "./toolLabels.js";
import { approvalMetaOf, approvalResponse, decisionOf, toolSummaryOf } from "./uiMessages.js";

type Invocation = ChatToolInvocation | ChatDynamicToolInvocation;

function verdictsOf(output: unknown): Partial<Record<(typeof CONSOLE_IDS)[number], Verdict>> | undefined {
  if (!isRecord(output) || !isRecord(output.verdicts)) return undefined;
  const verdicts: Partial<Record<(typeof CONSOLE_IDS)[number], Verdict>> = {};
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
      sx={{ m: 0, p: 1, bgcolor: "#060a0e", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 12, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

/** Tool call rendered as a friendly status line ("Checking the circuit… ✓") with collapsible details. */
export function ToolPartCard({ invocation, message }: { invocation: Invocation; message: ChatMessage }) {
  const { missionId, detail } = useMissionContext();
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const label = toolLabel(invocation.toolName);

  if (invocation.toolName === "ask_user") return <AskUserCard invocation={invocation} message={message} />;

  if (invocation.state === "approval-requested" || (invocation.state === "approval-responded" && invocation.approvalId)) {
    const approvalId = invocation.approvalId ?? invocation.toolCallId;
    const meta = approvalMetaOf(message.metadata, approvalId);
    const view = detail?.pendingApprovals.find((a) => a.id === approvalId);
    const summary = meta?.summary ?? view?.summary ?? `The agent wants to: ${invocation.toolName.replace(/_/g, " ")}`;
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
  const verdicts = invocation.state === "output-available" ? verdictsOf(invocation.output) : undefined;
  const status =
    invocation.state === "output-available"
      ? { icon: <CheckCircleIcon color="success" fontSize="small" />, text: label.done, word: "Done" }
      : invocation.state === "output-error"
        ? { icon: <ErrorIcon color="error" fontSize="small" />, text: `Couldn't finish: ${label.active.replace(/…$/, "").replace(/^\w/, (c) => c.toLowerCase())}`, word: "Failed" }
        : invocation.state === "output-denied"
          ? { icon: <BlockIcon color="warning" fontSize="small" />, text: label.active.replace(/…$/, ""), word: "Not allowed" }
          : invocation.state === "approval-responded"
            ? { icon: <HourglassTopIcon color="info" fontSize="small" />, text: label.active, word: "Continuing" }
            : { icon: <CircularProgress size={16} aria-hidden />, text: label.active, word: "Working" };

  return (
    <Paper variant="outlined" sx={{ my: 0.75, px: 1.5, py: 1, bgcolor: "rgba(125, 211, 252, 0.04)" }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
        {status.icon}
        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }} aria-live={running ? "polite" : undefined}>
          {status.text} <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>· {status.word}</Box>
        </Typography>
        <Button
          size="small"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailsId}
          endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        >
          {open ? "Hide details" : "Details"}
        </Button>
      </Stack>
      {summary && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
          {summary}
        </Typography>
      )}
      {verdicts && Object.keys(verdicts).length > 0 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: 1 }}>
          {CONSOLE_IDS.filter((id) => verdicts[id]).map((id) => (
            <Stack key={id} direction="row" sx={{ gap: 0.5, alignItems: "center" }}>
              <Typography variant="caption">{CONSOLE_LABELS[id]}</Typography>
              <VerdictChip verdict={verdicts[id]} />
            </Stack>
          ))}
        </Stack>
      )}
      {invocation.state === "output-error" && invocation.errorText && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {invocation.errorText}
        </Alert>
      )}
      {invocation.state === "output-denied" && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
          {invocation.approval?.reason === "deny" || !invocation.approval?.reason
            ? "You said no, so the agent skipped this step."
            : invocation.approval.reason}
        </Typography>
      )}
      <Collapse in={open} id={detailsId} unmountOnExit>
        <Stack sx={{ gap: 1, mt: 1 }}>
          <Typography variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary" }}>
            tool {invocation.toolName} · call {invocation.toolCallId}
          </Typography>
          {invocation.input !== undefined && (
            <>
              <Typography variant="caption">What the agent asked for</Typography>
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
    </Paper>
  );
}

/** `ask_user` (agent-only): the run stops after it; the question is shown with quick replies. */
function AskUserCard({ invocation, message }: { invocation: Invocation; message: ChatMessage }) {
  const chat = useChat();
  const input = isRecord(invocation.input) ? invocation.input : {};
  const question = typeof input.question === "string" ? input.question : "The agent has a question for you.";
  const choices = Array.isArray(input.choices) ? input.choices.filter((c): c is string => typeof c === "string") : [];
  const isLatest = chat.messages[chat.messages.length - 1]?.id === message.id;
  return (
    <Paper variant="outlined" sx={{ my: 1, p: 1.5, borderColor: "primary.main" }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
        <HelpOutlineIcon color="primary" fontSize="small" />
        <Typography variant="overline" sx={{ color: "primary.main", lineHeight: 1.4 }}>
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
