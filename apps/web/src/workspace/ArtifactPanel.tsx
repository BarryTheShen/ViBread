import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { CONSOLE_IDS, type ConsoleId, type MissionDetail } from "@vibread/core";
import { lazy, Suspense, useEffect } from "react";
import { useRevision, useRevisions } from "../api/hooks.js";
import { PANEL_VIEWS, type ArtifactPanelProps, type PanelView } from "../contracts.js";
import { PartsView } from "../inventory/PartsView.js";
import { PANEL_STAGES, PANEL_VIEW_HINTS, PANEL_VIEW_LABELS, stageOf } from "./panelViews.js";
import { PhotoTab } from "./tabs/PhotoTab.js";
import { SchematicTab } from "./tabs/SchematicTab.js";
import { TestsTab } from "./tabs/TestsTab.js";
import { TryItTab } from "./tabs/TryItTab.js";
import { DownloadMenu } from "./DownloadMenu.js";
import { BuildStepsView } from "./views/BuildStepsView.js";
import { ChecksView } from "./views/ChecksView.js";
import { ResultsView } from "./views/ResultsView.js";

const CodeTab = lazy(() => import("./tabs/CodeTab.js").then((m) => ({ default: m.CodeTab })));
// The bench (Web Serial, flasher, simulator) is the panel's biggest view; load it only when it's opened.
const BenchView = lazy(() => import("../bench/BenchView.js").then((m) => ({ default: m.BenchView })));

/** Views about building and testing the real board follow the build target; the rest follow the latest design. */
const FOLLOWS_BUILD_TARGET: ReadonlySet<PanelView> = new Set(["steps", "bench", "photos", "results"]);

/** Which design a view shows when the person hasn't picked one. */
export function defaultRevision(detail: MissionDetail, view: PanelView): number | undefined {
  const latest = detail.mission.currentRevision;
  return FOLLOWS_BUILD_TARGET.has(view) ? (detail.mission.releasedRevision ?? latest) : latest;
}

/** The side panel (plan §3.2): view switcher, design-version picker, download, close. */
export function ArtifactPanel({ missionId, detail, view, revision: pickedRevision, console: focusConsole, onViewChange, onRevisionChange, onClose }: ArtifactPanelProps) {
  const latest = detail.mission.currentRevision;
  const released = detail.mission.releasedRevision;
  const n = pickedRevision ?? defaultRevision(detail, view);
  const revisions = useRevisions(missionId);
  const revision = useRevision(missionId, n);
  const selectedRevision = revision.data?.n === n ? revision.data : undefined;
  const focus = CONSOLE_IDS.find((id): id is ConsoleId => id === focusConsole);

  // A new design version appears in the picker as soon as the agent makes it.
  const refetchRevisions = revisions.refetch;
  useEffect(() => {
    if (latest !== undefined) void refetchRevisions();
  }, [latest, refetchRevisions]);

  // Parts and the bench pick their own design version (the bench always checks the build target).
  const needsRevision = view !== "parts" && view !== "bench";

  return (
    <Box component="aside" aria-label="Mission details" sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, bgcolor: "background.paper" }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: "divider", minHeight: 56, flexWrap: "wrap" }}>
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel id="panel-view-label">Show</InputLabel>
          <Select
            labelId="panel-view-label"
            label="Show"
            value={view}
            onChange={(e) => onViewChange(PANEL_VIEWS.find((v) => v === e.target.value) ?? view)}
            renderValue={(v) => `${stageOf(v).n} · ${PANEL_VIEW_LABELS[v]}`}
            MenuProps={{ slotProps: { list: { dense: true, sx: { minWidth: 280, py: 0 } } } }}
          >
            {/* Stages in build order, numbered; MUI Select skips the subheaders when choosing with the keyboard. */}
            {PANEL_STAGES.flatMap((stage) => [
              <ListSubheader key={`stage-${stage.n}`} sx={{ lineHeight: "32px", fontWeight: 700, bgcolor: "background.paper" }}>
                {stage.n} · {stage.title}
              </ListSubheader>,
              ...stage.views.map((v) => (
                <MenuItem key={v} value={v} sx={{ pl: 3 }}>
                  <ListItemText primary={PANEL_VIEW_LABELS[v]} secondary={PANEL_VIEW_HINTS[v]} />
                </MenuItem>
              )),
            ])}
          </Select>
        </FormControl>
        {latest !== undefined && view !== "bench" && (
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel id="panel-revision-label">Design</InputLabel>
            <Select labelId="panel-revision-label" label="Design" value={n ?? ""} onChange={(e) => onRevisionChange(Number(e.target.value))}>
              {(revisions.data ?? [{ n: latest }]).map((r) => (
                <MenuItem key={r.n} value={r.n}>
                  <ListItemText
                    primary={`r${r.n}`}
                    secondary={[r.n === latest ? "latest" : "", r.n === released ? "build target" : ""].filter(Boolean).join(" · ") || undefined}
                    slotProps={{ primary: { sx: { display: "inline", mr: 1 } }, secondary: { sx: { display: "inline" } } }}
                  />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        <Box sx={{ flex: 1 }} />
        {selectedRevision && <DownloadMenu missionId={missionId} revision={selectedRevision} missionTitle={detail.mission.title} />}
        <Tooltip title="Close panel">
          <IconButton aria-label="Close panel" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      {needsRevision && revision.isFetching && <LinearProgress aria-label="Loading design" sx={{ height: 2 }} />}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>
        {view === "parts" ? (
          <PartsView missionId={missionId} missionParts={detail.mission.inventory} revision={n} />
        ) : view === "bench" ? (
          <Suspense fallback={<LinearProgress />}>
            <BenchView missionId={missionId} />
          </Suspense>
        ) : view === "checks" ? (
          <ChecksView
            consoles={selectedRevision?.results.reports ?? []}
            focus={focus}
            supersededBy={selectedRevision && latest !== undefined && selectedRevision.n < latest ? latest : undefined}
          />
        ) : latest === undefined ? (
          <Alert severity="info">Nothing to show yet. When Claude proposes a design, its schematic, code, tests, and build steps appear here.</Alert>
        ) : revision.isError ? (
          <Alert severity="error">Couldn't load design r{n}: {revision.error.message}</Alert>
        ) : !revision.data ? null : (
          <Suspense fallback={<LinearProgress />}>
            {view === "schematic" && <SchematicTab missionId={missionId} revision={revision.data} released={revision.data.n === released} />}
            {view === "steps" && <BuildStepsView missionId={missionId} revision={revision.data} released={revision.data.n === released} inventory={detail.mission.inventory} />}
            {view === "code" && <CodeTab revision={revision.data} />}
            {view === "tests" && <TestsTab revision={revision.data} recording={detail.recording} />}
            {view === "tryit" && <TryItTab missionId={missionId} revision={revision.data} released={revision.data.n === released} />}
            {view === "photos" && <PhotoTab revision={revision.data} />}
            {view === "results" && <ResultsView missionId={missionId} revision={revision.data} />}
          </Suspense>
        )}
      </Box>
    </Box>
  );
}
