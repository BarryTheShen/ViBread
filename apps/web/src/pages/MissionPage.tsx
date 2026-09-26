import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import HistoryIcon from "@mui/icons-material/History";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import MenuIcon from "@mui/icons-material/Menu";
import SettingsIcon from "@mui/icons-material/Settings";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { Theme } from "@mui/material/styles";
import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalView, Channel, PermissionMode } from "@vibread/core";
import { useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router";
import { queryKeys, useConnections, useMission, useRevision, useSetMode, useStopAgent, useTimeline } from "../api/hooks.js";
import { ApprovalCard } from "../chat/ApprovalCard.js";
import { MissionChat, useMissionChatAdapter } from "../chat/MissionChat.js";
import { ArtifactTabs } from "../workspace/ArtifactTabs.js";
import { ConsoleLights } from "../workspace/ConsoleLights.js";
import { FlightDirector } from "../workspace/FlightDirector.js";
import { MissionComplete } from "../workspace/MissionComplete.js";
import { MissionContext } from "../workspace/missionContext.js";
import { MODE_HELP, ModeSelect, PHYSICAL_NOTE } from "../workspace/ModeSelect.js";
import { PHASE_COPY, PhaseDrawer } from "../workspace/PhaseDrawer.js";

const CHANNEL_NAMES: Record<Channel, string> = {
  web: "this app",
  imessage: "iMessage",
  mcp: "Claude Code",
  a2a: "another agent",
  system: "ViBread",
};

const DRAWER_WIDTH = 260;

export default function MissionPage() {
  const { missionId = "" } = useParams<{ missionId: string }>();
  const mission = useMission(missionId);
  const timeline = useTimeline(missionId);
  const setMode = useSetMode(missionId);
  const stop = useStopAgent(missionId);
  const adapter = useMissionChatAdapter(missionId);
  const qc = useQueryClient();
  const wide = useMediaQuery((t: Theme) => t.breakpoints.up("lg"));
  const phone = useMediaQuery("(max-width: 699.95px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatApprovalIds, setChatApprovalIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const detail = mission.data;
  const contextValue = useMemo(() => ({ missionId, detail }), [missionId, detail]);
  const released = useRevision(missionId, detail?.mission.releasedRevision);
  const lastRunVirtual = released.data?.results.bench?.at(-1)?.runId.startsWith("virtual-") ?? false;
  const connections = useConnections();
  // Nothing powers the agent: no connected Claude account and no server key.
  const claudeMissing = connections.data?.claude?.using === "none";

  if (mission.isPending) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <CircularProgress aria-label="Loading mission" />
      </Box>
    );
  }
  if (!detail) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error" action={<Button component={RouterLink} to="/">Home</Button>}>
          Couldn't open this mission: {mission.error?.message ?? "not found"}
        </Alert>
      </Box>
    );
  }

  const { mission: m } = detail;
  if (phone) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2 }}>
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 420, display: "flex", flexDirection: "column", gap: 2 }}>
          <Typography variant="overline" sx={{ color: "text.secondary" }}>
            Mission Control
          </Typography>
          <Typography variant="h2" component="h1">
            {m.title}
          </Typography>
          <Typography>
            The full workspace needs a laptop-sized screen. On your phone, Build Mode shows one build step at a time, right next to your
            breadboard.
          </Typography>
          <Button component={RouterLink} to={`/b/${missionId}`} variant="contained" size="large" startIcon={<PhoneIphoneIcon />} sx={{ minHeight: 48 }}>
            Open Build Mode for this mission
          </Button>
          <Button component={RouterLink} to="/" variant="outlined" sx={{ minHeight: 48 }}>
            All missions
          </Button>
        </Paper>
      </Box>
    );
  }
  const offline = mission.isError;
  // Approvals requested outside this chat (Claude Code, iMessage, or before this page loaded) still need a card.
  const outsideApprovals = detail.pendingApprovals.filter((a) => a.status === "pending" && !chatApprovalIds.includes(a.id));

  const changeMode = (mode: PermissionMode) =>
    setMode.mutate(mode, { onSuccess: () => setNotice(`Mode set to ${mode === "ask" ? "Ask every time" : mode[0].toUpperCase() + mode.slice(1)}.`) });

  const drawer = <PhaseDrawer missionId={missionId} phase={m.phase} timeline={timeline.data ?? []} />;

  return (
    <MissionContext.Provider value={contextValue}>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <AppBar position="static">
          <Toolbar sx={{ gap: 1.5, minHeight: 64 }}>
            {!wide && (
              <IconButton aria-label="Show mission steps" onClick={() => setDrawerOpen(true)}>
                <MenuIcon />
              </IconButton>
            )}
            <Tooltip title="All missions">
              <IconButton component={RouterLink} to="/" aria-label="Back to all missions">
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
            <Box sx={{ minWidth: 0, flexShrink: 1 }}>
              <Typography variant="h3" component="h1" noWrap title={m.title}>
                {m.title}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                Now: {PHASE_COPY[m.phase].label}
                {m.releasedRevision ? ` · ${m.phase === "DONE" || m.phase === "LAUNCH" ? "built" : "building"} design r${m.releasedRevision}` : m.currentRevision ? ` · design r${m.currentRevision}` : ""}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <ModeSelect value={m.mode} onChange={changeMode} disabled={setMode.isPending} />
            </Box>
            <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 300, display: { xs: "none", xl: "block" } }}>
              {MODE_HELP[m.mode]}
            </Typography>
            {!offline && !detail.agentBusy && claudeMissing ? (
              <Chip
                icon={<LinkOffIcon />}
                color="warning"
                variant="outlined"
                clickable
                component={RouterLink}
                to="/settings"
                label="Claude not connected"
                aria-label="Claude not connected: the agent can't reply. Open Settings to connect it."
              />
            ) : (
              <Chip
                icon={offline ? <CloudOffIcon /> : detail.agentBusy ? <CircularProgress size={14} aria-hidden /> : <CloudDoneIcon />}
                color={offline ? "error" : "default"}
                variant="outlined"
                label={offline ? "Server unreachable" : detail.agentBusy ? "Agent working" : "Connected · agent idle"}
                aria-live="polite"
              />
            )}
            <Button
              variant="contained"
              color="error"
              startIcon={<StopCircleIcon />}
              disabled={!detail.agentBusy || stop.isPending}
              onClick={() => {
                adapter.stop?.();
                stop.mutate(undefined, { onSuccess: () => setNotice("Agent stopped. Work done so far is kept.") });
              }}
            >
              Stop agent
            </Button>
            <Tooltip title="Settings and connections">
              <IconButton component={RouterLink} to="/settings" aria-label="Settings and connections">
                <SettingsIcon />
              </IconButton>
            </Tooltip>
          </Toolbar>
          <Box sx={{ px: 2, pb: 0.75, display: { xs: "block", xl: "none" } }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {MODE_HELP[m.mode]} {PHYSICAL_NOTE}
            </Typography>
          </Box>
          <Box sx={{ px: 2, pb: 0.75, display: { xs: "none", xl: "block" } }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {PHYSICAL_NOTE}
            </Typography>
          </Box>
        </AppBar>

        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          {wide ? (
            <Box sx={{ width: DRAWER_WIDTH, flexShrink: 0, borderRight: 1, borderColor: "divider", bgcolor: "#0b1118" }}>{drawer}</Box>
          ) : (
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} slotProps={{ paper: { sx: { width: DRAWER_WIDTH } } }}>
              {drawer}
            </Drawer>
          )}
          <Box component="main" sx={{ flex: "1 1 40%", minWidth: 360, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {outsideApprovals.length > 0 && (
              <Box
                component="section"
                sx={{ px: 2, pt: 0.5, maxHeight: "40%", overflow: "auto", borderBottom: 1, borderColor: "divider" }}
                aria-label="Waiting for your decision"
              >
                {outsideApprovals.map((a: ApprovalView) => (
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
                    onDecide={async (decision) => {
                      // The adapter posts the decision and the chat follows the resumed agent run.
                      await adapter.decide(a.id, decision);
                      await qc.invalidateQueries({ queryKey: queryKeys.mission(missionId) });
                    }}
                  />
                ))}
              </Box>
            )}
            <MissionComplete
              missionId={missionId}
              phase={m.phase}
              virtualBoard={lastRunVirtual}
              onTellAgent={() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the agent"]')?.focus()}
            />
            {detail.recording && (
              <Alert severity="info" icon={<HistoryIcon />} sx={{ mx: 2, mt: 1, py: 0 }}>
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
            {claudeMissing && (
              <Alert
                severity="info"
                sx={{ mx: 2, mt: 1, py: 0 }}
                action={
                  <Button component={RouterLink} to="/settings" size="small" sx={{ whiteSpace: "nowrap" }}>
                    Connect in Settings
                  </Button>
                }
              >
                Claude isn't connected, so the agent can't chat. Checks, tests, and building still work.
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <MissionChat
                missionId={missionId}
                agentBusy={detail.agentBusy}
                adapter={adapter}
                brief={m.brief}
                hasDesign={m.currentRevision !== undefined}
                designChannel={detail.revision?.author.channel}
                // The server moves a fresh mission BRIEF → CLARIFY on creation (BRIEF_RECEIVED); either way no design exists yet.
                isNewMission={(m.phase === "BRIEF" || m.phase === "CLARIFY") && m.currentRevision === undefined}
                onApprovalIdsChange={setChatApprovalIds}
              />
            </Box>
          </Box>
          <Box
            component="aside"
            aria-label="Design files"
            sx={{ flex: "1 1 45%", minWidth: 380, borderLeft: 1, borderColor: "divider", bgcolor: "#0b1118", minHeight: 0 }}
          >
            <ArtifactTabs missionId={missionId} detail={detail} />
          </Box>
        </Box>
        <ConsoleLights reports={detail.consoles} action={<FlightDirector missionId={missionId} detail={detail} />} />
      </Box>
      <Snackbar open={notice !== null} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice ?? ""} />
    </MissionContext.Provider>
  );
}
