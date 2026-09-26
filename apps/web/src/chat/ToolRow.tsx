import BlockIcon from "@mui/icons-material/Block";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { CONSOLE_IDS, CONSOLE_LABELS, type Verdict } from "@vibread/core";
import { useId, useState } from "react";
import { VerdictChip } from "../components/VerdictChip.js";
import { isRecord } from "../lib/guards.js";
import { INTER_FONT, MONO_FONT } from "../theme.js";
import { useMissionShell } from "./missionShell.js";
import { toolLabel } from "./toolLabels.js";
import { toolSummaryOf } from "./uiMessages.js";

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
      sx={{ m: 0, p: 1, bgcolor: "action.hover", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 12, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

export type ToolRowProps = Pick<ToolCallMessagePartProps, "toolName" | "toolCallId" | "args" | "result" | "isError" | "status" | "approval">;

/** One tool call as a compact one-line row ("Checked the circuit ✓ · all GO") that expands to its details. */
export function ToolRow({ toolName, toolCallId, args, result, isError, status, approval }: ToolRowProps) {
  const { detail, openPanel } = useMissionShell();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const label = toolLabel(toolName, args);
  const done = status.type === "complete" && !isError;
  // Calls that waited for a permission that no longer exists (older chat history) or were denied never ran.
  const notRun = approval !== undefined || status.type === "requires-action" || (status.type === "incomplete" && status.reason === "cancelled");
  const failed = isError === true && !notRun;
  const errorText = failed && isRecord(result) && typeof result.error === "string" ? result.error : undefined;
  const summary = done ? toolSummaryOf(result) : undefined;
  // One source of truth: when the tool reports on the revision the mission detail describes, show the live console
  // reports (MissionDetail.consoles); older revisions keep the votes they got at the time.
  const outputRevision = isRecord(result) && typeof result.revision === "number" ? result.revision : undefined;
  const reported = done ? verdictsOf(result) : undefined;
  const live = reported !== undefined && outputRevision !== undefined && outputRevision === detail.revision?.n;
  const verdicts: Verdicts | undefined = live ? Object.fromEntries(detail.consoles.map((c) => [c.console, c.verdict])) : reported;
  const verdictList = verdicts ? Object.values(verdicts) : [];
  const verdictStatus =
    verdictList.length === 0 ? undefined : verdictList.every((v) => v === "GO") ? "all GO" : `${verdictList.filter((v) => v === "GO").length} of ${verdictList.length} GO`;
  const view = done
    ? { icon: <CheckCircleOutlineIcon fontSize="small" sx={{ color: "success.main" }} />, text: label.done, word: verdictStatus ?? summary }
    : failed
      ? { icon: <ErrorOutlineIcon fontSize="small" sx={{ color: "error.main" }} />, text: `Couldn't finish: ${label.active.replace(/…$/, "").replace(/^\w/, (c) => c.toLowerCase())}`, word: "failed" }
      : notRun || status.type === "incomplete"
        ? { icon: <BlockIcon fontSize="small" sx={{ color: "text.secondary" }} />, text: label.active.replace(/…$/, ""), word: "not run" }
        : { icon: <CircularProgress size={16} aria-hidden />, text: label.active, word: undefined };
  const running = status.type === "running";
  const opensPanel = outputRevision !== undefined && (toolName === "propose_design" || verdictList.length > 0);

  return (
    <Box sx={{ my: 0.25, fontFamily: INTER_FONT }} data-tool={toolName}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: 32, px: 1 }}>
        {view.icon}
        <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }} aria-live={running ? "polite" : undefined}>
          {view.text}
        </Typography>
        {view.word && (
          <Typography variant="body2" noWrap sx={{ color: "text.secondary", minWidth: 0, flexShrink: 1 }}>
            · {view.word}
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
      {errorText && (
        <Alert severity="error" sx={{ mt: 0.5 }}>
          {errorText}
        </Alert>
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
            tool {toolName} · call {toolCallId}
          </Typography>
          {args !== undefined && Object.keys(args).length > 0 && (
            <>
              <Typography variant="caption">What Claude asked for</Typography>
              <Json value={args} />
            </>
          )}
          {done && result !== undefined && (
            <>
              <Typography variant="caption">What came back</Typography>
              <Json value={result} />
            </>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}
