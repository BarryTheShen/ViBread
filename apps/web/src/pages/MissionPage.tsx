import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useQuery } from "@tanstack/react-query";
import { MODE_LABELS, type MissionDetail, type PermissionMode, type TimelineEvent } from "@vibread/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useParams } from "react-router";
import { api } from "../api/client.js";
import { queryKeys, useConnections, useMission, useRevisions, useSetMode } from "../api/hooks.js";
import { isSignInRequired, SignInRequired } from "../components/SignIn.js";
import type { MissionShellValue, PanelView } from "../contracts.js";
import { MissionChat, useMissionChatAdapter } from "../chat/MissionChat.js";
import { MissionShellContext } from "../chat/missionShell.js";
import { withRevisionEvents } from "../chat/timeline.js";
import { isRecord } from "../lib/guards.js";
import { ArtifactPanel } from "../workspace/ArtifactPanel.js";
import { MissionCompleteCard } from "../workspace/MissionCompleteCard.js";
import { MissionHeader } from "../workspace/MissionHeader.js";

const EMPTY_EVENTS: TimelineEvent[] = [];

interface PanelState {
  open: boolean;
  view: PanelView;
  revision?: number;
  console?: string;
}

/**
 * Opens the panel by itself at the moments the plan names (§3.2): the first design (Schematic), GO for build (Build
 * steps) and a bench problem (Diagnosis). Only on changes seen while the page is open, never on first load.
 */
function useAutoPanel(detail: MissionDetail | undefined, events: TimelineEvent[], open: (view: PanelView) => void) {
  const seen = useRef<{ revision?: number; released?: number; failures: string[] } | null>(null);
  useEffect(() => {
    if (!detail) return;
    const now = { revision: detail.mission.currentRevision, released: detail.mission.releasedRevision, failures: events.filter((e) => e.kind === "bench.run" && isRecord(e.data) && e.data.verdict === "fail").map((e) => e.id) };
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    if (now.failures.some((id) => !before.failures.includes(id))) open("diagnosis");
    else if (now.released !== undefined && now.released !== before.released) open("steps");
    else if (before.revision === undefined && now.revision !== undefined) open("schematic");
  }, [detail, events, open]);
}

export default function MissionPage() {
  const { missionId = "" } = useParams<{ missionId: string }>();
  const mission = useMission(missionId);
  const detail = mission.data;
  const busy = detail?.agentBusy ?? false;
  // Same query as useTimeline; this observer polls faster while Claude works so its rows land in the chat promptly.
  const timeline = useQuery({
    queryKey: queryKeys.timeline(missionId),
    queryFn: ({ signal }) => api.timeline(missionId, undefined, signal),
    refetchInterval: busy ? 1_500 : 5_000,
  });
  const revisions = useRevisions(missionId);
  const events = useMemo(
    () => withRevisionEvents(timeline.data ?? EMPTY_EVENTS, revisions.data ?? [], missionId),
    [timeline.data, revisions.data, missionId],
  );
  const setMode = useSetMode(missionId);
  const adapter = useMissionChatAdapter(missionId);
  const connections = useConnections();
  // Nothing powers the agent: no connected Claude account and no server key.
  const claudeMissing = connections.data?.claude?.using === "none";
  const phone = useMediaQuery("(max-width: 699.95px)");
  const roomy = useMediaQuery("(min-width: 1200px)");
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [panel, setPanel] = useState<PanelState>({ open: false, view: "schematic" });
  const panelTouched = useRef(false);

  const openPanel = useCallback<MissionShellValue["openPanel"]>((view, options) => {
    panelTouched.current = true;
    setPanel({ open: true, view, revision: options?.revision, console: options?.console });
  }, []);
  const closePanel = useCallback(() => {
    panelTouched.current = true;
    setPanel((p) => ({ ...p, open: false }));
  }, []);
  const autoOpen = useCallback((view: PanelView) => setPanel({ open: true, view }), []);
  useAutoPanel(detail, events, autoOpen);

  // A mission that already has a design opens with its schematic beside the chat on a wide screen.
  const hasDesign = detail?.mission.currentRevision !== undefined;
  useEffect(() => {
    if (hasDesign && roomy && !panelTouched.current) setPanel((p) => (p.open ? p : { ...p, open: true }));
  }, [hasDesign, roomy]);

  // Buttons elsewhere (panel: "Ask Claude to redesign without it", "Fix and retest") prefill the chat box.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = e instanceof CustomEvent && typeof e.detail?.text === "string" ? e.detail.text : "";
      if (!text) return;
      setDraft(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("vibread:ask-agent", onAsk);
    return () => window.removeEventListener("vibread:ask-agent", onAsk);
  }, []);

  const shell = useMemo<MissionShellValue | null>(
    () =>
      detail
        ? { missionId, detail, panel: { open: panel.open, view: panel.view, revision: panel.revision }, openPanel, closePanel }
        : null,
    [missionId, detail, panel.open, panel.view, panel.revision, openPanel, closePanel],
  );

  const changeMode = useCallback(
    (mode: PermissionMode) => setMode.mutate(mode, { onSuccess: () => setNotice(`Mode set to ${MODE_LABELS[mode]}.`) }),
    [setMode],
  );

  if (mission.isPending) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", height: "100%" }}>
        <CircularProgress aria-label="Loading mission" />
      </Box>
    );
  }
  if (!detail || !shell) {
    return (
      <Box sx={{ p: 4 }}>
        {isSignInRequired(mission.error) ? (
          <SignInRequired />
        ) : (
          <Alert severity="error" action={<Button component={RouterLink} to="/">New mission</Button>}>
            Couldn't open this mission: {mission.error?.message ?? "not found"}
          </Alert>
        )}
      </Box>
    );
  }

  const m = detail.mission;
  if (phone) {
    return (
      <Box sx={{ minHeight: "100%", display: "grid", placeItems: "center", p: 2 }}>
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 420, display: "flex", flexDirection: "column", gap: 2 }}>
          <Typography variant="h2" component="h1">
            {m.title}
          </Typography>
          <Typography>
            The mission chat needs a laptop-sized screen. On your phone, Build Mode shows one build step at a time, right next to your breadboard.
          </Typography>
          <Button component={RouterLink} to={`/b/${missionId}`} variant="contained" size="large" startIcon={<PhoneIphoneIcon />} sx={{ minHeight: 48 }}>
            Open Build Mode for this mission
          </Button>
        </Paper>
      </Box>
    );
  }

  return (
    <MissionShellContext.Provider value={shell}>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <MissionHeader missionId={missionId} detail={detail} onOpenPanel={openPanel} />
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <Box component="main" aria-label="Mission chat" sx={{ flex: "1 1 55%", minWidth: 380, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <MissionChat
              missionId={missionId}
              detail={detail}
              adapter={adapter}
              events={events}
              canChat={!claudeMissing}
              mode={m.mode}
              onModeChange={changeMode}
              draft={draft}
              setDraft={setDraft}
              inputRef={inputRef}
              afterMessages={<MissionCompleteCard missionId={missionId} detail={detail} onTellAgent={() => inputRef.current?.focus()} />}
            />
          </Box>
          {panel.open && (
            <Box
              component="aside"
              aria-label="Mission panel"
              sx={{ flex: "1 1 45%", minWidth: 420, maxWidth: 900, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", minHeight: 0 }}
            >
              <ArtifactPanel
                missionId={missionId}
                detail={detail}
                view={panel.view}
                revision={panel.revision}
                console={panel.console}
                onViewChange={(view) => setPanel((p) => ({ ...p, view, console: undefined }))}
                onRevisionChange={(revision) => setPanel((p) => ({ ...p, revision }))}
                onClose={closePanel}
              />
            </Box>
          )}
        </Box>
      </Box>
      <Snackbar open={notice !== null} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice ?? ""} />
    </MissionShellContext.Provider>
  );
}
