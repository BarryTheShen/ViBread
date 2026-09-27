import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import HistoryIcon from "@mui/icons-material/History";
import HourglassBottomIcon from "@mui/icons-material/HourglassBottom";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import ListAltIcon from "@mui/icons-material/ListAlt";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import InputBase from "@mui/material/InputBase";
import ListItemIcon from "@mui/material/ListItemIcon";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { CONSOLE_IDS, CONSOLE_LABELS, type ConsoleId, type ConsoleReport } from "@vibread/core";
import type { ReactElement } from "react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { useBuildState, useConnections, useRevision, useStopAgent, useTimeline } from "../api/hooks.js";
import type { MissionHeaderProps, NextStep } from "../contracts.js";
import { isRecord } from "../lib/guards.js";
import { nextStepOf } from "./nextStep.js";
import { GoForBuildButton } from "./GoForBuild.js";
import { MissionActions, useMissionActions, validateMissionTitle } from "./MissionActions.js";
import { PhoneLinkDialog } from "./PhoneLink.js";

/** Short names for the five status dots (the Apollo console name is in the tooltip). */
const DOT_LABEL: Record<ConsoleId, string> = {
  EECOM: "Electrical",
  GUIDO: "Firmware",
  FIDO: "Simulation",
  FAO: "Assembly",
  RETRO: "Review",
};

/** Every verdict has its own shape as well as its colour (never colour alone). */
function dotFor(report: ConsoleReport | undefined): { icon: ReactElement; word: string } {
  const warnings = report?.findings.filter((f) => f.severity === "warning").length ?? 0;
  switch (report?.verdict) {
    case "GO":
      return { icon: <CheckCircleIcon color="success" />, word: warnings > 0 ? `GO · ${warnings} warning${warnings === 1 ? "" : "s"}` : "GO" };
    case "NO-GO":
      return { icon: <CancelIcon color="error" />, word: "NO-GO" };
    case "PENDING":
      return { icon: <HourglassBottomIcon color="warning" />, word: "Waiting" };
    case "SKIPPED":
      return { icon: <RemoveCircleOutlineIcon sx={{ color: "text.secondary" }} />, word: "Skipped" };
    default:
      return { icon: <RadioButtonUncheckedIcon sx={{ color: "text.secondary" }} />, word: "Not run yet" };
  }
}

function recordedVote(report: ConsoleReport | undefined): string | undefined {
  const recorded = report?.evidence?.recorded;
  return isRecord(recorded) && typeof recorded.label === "string" ? recorded.label : undefined;
}

function StatusDots({ consoles, onOpen }: { consoles: ConsoleReport[]; onOpen(console: ConsoleId): void }) {
  return (
    <Stack direction="row" component="ul" aria-label="Checks" sx={{ gap: 0.25, m: 0, p: 0, listStyle: "none" }}>
      {CONSOLE_IDS.map((id) => {
        const report = consoles.find((c) => c.console === id);
        const dot = dotFor(report);
        const recorded = recordedVote(report);
        const label = `${CONSOLE_LABELS[id]} (${id}): ${dot.word}${recorded ? ` — ${recorded}, not live` : ""}`;
        return (
          <li key={id}>
            <Tooltip title={label} describeChild>
              <ButtonBase
                onClick={() => onOpen(id)}
                aria-label={`${label}. Show details`}
                sx={{ borderRadius: "50%", width: 30, height: 30, display: "grid", placeItems: "center", "& svg": { fontSize: 20 } }}
              >
                {dot.icon}
              </ButtonBase>
            </Tooltip>
          </li>
        );
      })}
    </Stack>
  );
}

function NextStepButton({ step, props, onStop, stopping }: { step: NextStep; props: MissionHeaderProps; onStop(): void; stopping: boolean }) {
  const { missionId, detail, onOpenPanel } = props;
  const toCard = () => {
    const card = document.getElementById("mission-complete-card");
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.focus();
  };
  switch (step.kind) {
    case "working":
      return (
        <Button variant="outlined" color="inherit" startIcon={<StopCircleIcon />} disabled={stopping} onClick={onStop} sx={{ whiteSpace: "nowrap" }}>
          <CircularProgress size={14} sx={{ mr: 1 }} aria-hidden />
          Claude is working… · Stop
        </Button>
      );
    case "go":
      return <GoForBuildButton missionId={missionId} detail={detail} onReleased={(n) => onOpenPanel("steps", { revision: n })} />;
    case "build":
      return (
        <Button variant="contained" startIcon={<ListAltIcon />} onClick={() => onOpenPanel("steps")} sx={{ whiteSpace: "nowrap" }}>
          Build steps · {step.done}/{step.total}
        </Button>
      );
    case "bench":
      return (
        <Button variant="contained" startIcon={<UsbIcon />} onClick={() => onOpenPanel("bench")} sx={{ whiteSpace: "nowrap" }}>
          Test on the bench
        </Button>
      );
    case "bench-real":
      return (
        <Tooltip title="The virtual board passed — that was practice. Run the bench with your real Arduino to finish." describeChild>
          <Button variant="contained" startIcon={<UsbIcon />} onClick={() => onOpenPanel("bench")} sx={{ whiteSpace: "nowrap" }}>
            Test with your Arduino
          </Button>
        </Tooltip>
      );
    case "confirm":
      return (
        <Button variant="contained" startIcon={<ThumbUpOutlinedIcon />} onClick={toCard} sx={{ whiteSpace: "nowrap" }}>
          Does it work?
        </Button>
      );
    case "done":
      return (
        <Button variant="outlined" color="success" startIcon={<DoneAllIcon />} onClick={toCard} sx={{ whiteSpace: "nowrap" }}>
          Done
        </Button>
      );
  }
}

/** Title (click to rename), five status dots, the next-step button, Claude chip, ⋯ menu, recording banner (plan §3.2). */
export function MissionHeader(props: MissionHeaderProps) {
  const { missionId, detail, onOpenPanel } = props;
  const m = detail.mission;
  const stop = useStopAgent(missionId);
  const actions = useMissionActions({ missionId, title: m.title });
  const connections = useConnections();
  const timeline = useTimeline(missionId);
  const releasedWithOverride = m.releasedRevision !== undefined && (timeline.data ?? []).some((event) => event.kind === "release.override" && event.revision === m.releasedRevision);
  const released = m.releasedRevision !== undefined;
  const build = useBuildState(missionId, released);
  const releasedRevision = useRevision(missionId, m.releasedRevision);
  const step = nextStepOf(detail, build.data, releasedRevision.data?.results.bench);
  const claudeMissing = connections.data?.claude?.using === "none";
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const commitTitle = () => {
    const next = title.trim();
    if (validateMissionTitle(next)) {
      setTitle(m.title);
      setEditing(false);
      return;
    }
    setEditing(false);
    if (next !== m.title) actions.rename.mutate(next);
    else setTitle(m.title);
  };

  return (
    // A size container: on a narrow header (1024 px window, open panel) the status chip shrinks to its icon so the
    // mission title keeps its room.
    <Box component="header" sx={{ borderBottom: 1, borderColor: "divider", containerType: "inline-size" }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1.5, px: 2, py: 1, minHeight: 56 }}>
        <Box sx={{ minWidth: 0, flex: "1 1 auto" }}>
          {editing ? (
            <InputBase
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitle(m.title);
                  setEditing(false);
                }
              }}
              slotProps={{ input: { "aria-label": "Mission name", maxLength: 80 } }}
              sx={{ typography: "h6", width: "100%" }}
            />
          ) : (
            <Tooltip title="Rename" describeChild>
              <ButtonBase
                onClick={() => {
                  setTitle(m.title);
                  setEditing(true);
                }}
                sx={{ maxWidth: "100%", justifyContent: "flex-start", borderRadius: 1, px: 0.5, mx: -0.5 }}
              >
                <Typography variant="h6" component="h1" noWrap>
                  {actions.rename.isPending ? title : m.title}
                </Typography>
              </ButtonBase>
            </Tooltip>
          )}
        </Box>
        <StatusDots consoles={detail.consoles} onOpen={(console) => onOpenPanel("checks", { console })} />
        {claudeMissing && step.kind !== "working" && (
          <Tooltip title="Claude not connected: the agent can't reply. Open Settings to connect it.">
            <Chip
              icon={<LinkOffIcon />}
              color="warning"
              variant="outlined"
              size="small"
              clickable
              component={RouterLink}
              to="/settings"
              label="Claude not connected"
              aria-label="Claude not connected: the agent can't reply. Open Settings to connect it."
              sx={{
                flexShrink: 0,
                "@container (max-width: 1000px)": { minWidth: 32, "& .MuiChip-label": { display: "none" }, "& .MuiChip-icon": { mx: 0.75 } },
              }}
            />
          </Tooltip>
        )}
        {releasedWithOverride && (
          <Tooltip title="This build target bypassed one or more safety checks. See the mission timeline for details." describeChild>
            <Chip color="warning" variant="outlined" size="small" label="Released with override" aria-label="Released with override" sx={{ flexShrink: 0 }} />
          </Tooltip>
        )}
        <NextStepButton step={step} props={props} onStop={() => stop.mutate()} stopping={stop.isPending} />
        <MissionActions
          missionId={missionId}
          title={m.title}
          actions={actions}
          onRename={() => {
            setTitle(m.title);
            setEditing(true);
          }}
          buttonLabel="More mission actions"
          extraItems={(closeMenu) => (
            <>
              <MenuItem onClick={() => { closeMenu(); onOpenPanel("bench"); }}>
                <ListItemIcon><UsbIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary="Open the bench" secondary="Flash and self-test on this laptop" />
              </MenuItem>
              <MenuItem onClick={() => { closeMenu(); setPhoneOpen(true); }}>
                <ListItemIcon><PhoneIphoneIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary="Phone link" secondary="QR code for Build Mode" />
              </MenuItem>
            </>
          )}
        />
      </Stack>
      {actions.rename.isError && (
        <Alert severity="error" sx={{ mx: 2, mb: 1 }} onClose={() => actions.rename.reset()}>
          Couldn't rename the mission: {actions.rename.error.message}
        </Alert>
      )}
      {detail.recording && (
        <Alert severity="info" icon={<HistoryIcon />} sx={{ mx: 2, mb: 1, py: 0 }}>
          <Tooltip title={detail.recording.provenance} describeChild>
            <Box component="span" tabIndex={0} sx={{ fontWeight: 600 }}>
              {detail.recording.label}
            </Box>
          </Tooltip>{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            Design: {detail.recording.models.design} · Tests and review: {detail.recording.models.testAuthor}
          </Box>
        </Alert>
      )}
      <PhoneLinkDialog missionId={missionId} open={phoneOpen} onClose={() => setPhoneOpen(false)} />
    </Box>
  );
}
