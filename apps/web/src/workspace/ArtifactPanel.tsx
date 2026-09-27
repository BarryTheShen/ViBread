import CloseIcon from "@mui/icons-material/Close";
import DownloadIcon from "@mui/icons-material/Download";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { CONSOLE_IDS, type ConsoleId, type MissionDetail } from "@vibread/core";
import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { useRevision, useRevisions } from "../api/hooks.js";
import { PANEL_VIEWS, type ArtifactPanelProps, type PanelView } from "../contracts.js";
import { PartsView } from "../inventory/PartsView.js";
import { PhotoTab } from "./tabs/PhotoTab.js";
import { ReplayTab } from "./tabs/ReplayTab.js";
import { SchematicTab } from "./tabs/SchematicTab.js";
import { TelemetryTab } from "./tabs/TelemetryTab.js";
import { TestsTab } from "./tabs/TestsTab.js";
import { TryItTab } from "./tabs/TryItTab.js";
import { BuildStepsView } from "./views/BuildStepsView.js";
import { ChecksView } from "./views/ChecksView.js";
import { DiagnosisView } from "./views/DiagnosisView.js";

const CodeTab = lazy(() => import("./tabs/CodeTab.js").then((m) => ({ default: m.CodeTab })));

export const PANEL_VIEW_LABELS: Record<PanelView, string> = {
  parts: "Parts",
  schematic: "Schematic",
  steps: "Build steps",
  code: "Code",
  tests: "Tests",
  tryit: "Try it",
  replay: "Replay",
  checks: "Checks",
  telemetry: "Telemetry",
  diagnosis: "Diagnosis",
  photos: "Photo checks",
};

/** Views about building and testing the real board follow the build target; the rest follow the latest design. */
const FOLLOWS_BUILD_TARGET: ReadonlySet<PanelView> = new Set(["steps", "telemetry", "diagnosis", "photos"]);

/** Which design a view shows when the person hasn't picked one. */
export function defaultRevision(detail: MissionDetail, view: PanelView): number | undefined {
  const latest = detail.mission.currentRevision;
  return FOLLOWS_BUILD_TARGET.has(view) ? (detail.mission.releasedRevision ?? latest) : latest;
}

/** A download's menu section, ordered from the most useful design outputs to diagnostics. */
type DownloadGroup = "Design files" | "Step pictures" | "Code" | "Reports";

const DOWNLOAD_GROUPS: readonly DownloadGroup[] = ["Design files", "Step pictures", "Code", "Reports"];

interface DownloadItem {
  key: string;
  url: string;
  label: string;
  group: DownloadGroup;
}

function artifactFormat(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1);
  return extension && extension !== key ? extension.toUpperCase() : "FILE";
}

function downloadGroup(key: string): DownloadGroup {
  if (/^step-\d+\.(?:svg|png)$/.test(key)) return "Step pictures";
  if (/^(?:schematic|breadboard)\.(?:svg|png)$/.test(key)) return "Design files";
  if (key === "app.hex" || key === "bench.hex" || key === "sketch.ino" || /\.(?:hex|ino)$/.test(key)) return "Code";
  return "Reports";
}

/** Friendly names for artifact keys, keeping the file format visible when two formats exist. */
function downloadLabel(key: string): string {
  const step = /^step-(\d+)\.(svg|png)$/.exec(key);
  if (step) return `Step ${step[1]} picture · ${step[2].toUpperCase()}`;
  if (key === "schematic.svg") return "Schematic · SVG";
  if (key === "schematic.png") return "Schematic · PNG";
  if (key === "breadboard.svg") return "Breadboard picture · SVG";
  if (key === "breadboard.png") return "Breadboard picture · PNG";
  if (key === "sketch.ino") return "Arduino sketch · INO";
  if (key === "app.hex") return "Compiled sketch · HEX";
  if (key === "bench.hex") return "Bench self-test firmware · HEX";
  const trace = /^trace-(.+)\.json$/.exec(key);
  if (trace) return `Simulation trace · ${trace[1]} · JSON`;
  const photo = /^photo-step-(\d+)\.([^.]+)$/.exec(key);
  if (photo) return `Photo check · step ${photo[1]} · ${photo[2].toUpperCase()}`;
  const stem = key.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} · ${artifactFormat(key)}`;
}

function downloadItems(artifacts: [string, string][]): DownloadItem[] {
  return artifacts
    // Focus images are an internal crop used by Build Mode, not separate design deliverables.
    .filter(([key]) => !/^step-\d+-focus\.(?:svg|png)$/.test(key))
    .map(([key, url]) => ({ key, url, label: downloadLabel(key), group: downloadGroup(key) }))
    .sort((a, b) => {
      const groupOrder = DOWNLOAD_GROUPS.indexOf(a.group) - DOWNLOAD_GROUPS.indexOf(b.group);
      if (groupOrder !== 0) return groupOrder;
      const aStep = /^step-(\d+)\.(svg|png)$/.exec(a.key);
      const bStep = /^step-(\d+)\.(svg|png)$/.exec(b.key);
      if (aStep && bStep) {
        const numberOrder = Number(aStep[1]) - Number(bStep[1]);
        if (numberOrder !== 0) return numberOrder;
        return (aStep[2] === "svg" ? 0 : 1) - (bStep[2] === "svg" ? 0 : 1);
      }
      return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
    });
}

/** The side panel (plan §3.2): view switcher, design-version picker, download, close. */
export function ArtifactPanel({ missionId, detail, view, revision: pickedRevision, console: focusConsole, onViewChange, onRevisionChange, onClose }: ArtifactPanelProps) {
  const latest = detail.mission.currentRevision;
  const released = detail.mission.releasedRevision;
  const n = pickedRevision ?? defaultRevision(detail, view);
  const revisions = useRevisions(missionId);
  const revision = useRevision(missionId, n);
  const selectedRevision = revision.data?.n === n ? revision.data : undefined;
  const [downloadAnchor, setDownloadAnchor] = useState<HTMLElement | null>(null);
  const focus = CONSOLE_IDS.find((id): id is ConsoleId => id === focusConsole);

  // A new design version appears in the picker as soon as the agent makes it.
  const refetchRevisions = revisions.refetch;
  useEffect(() => {
    if (latest !== undefined) void refetchRevisions();
  }, [latest, refetchRevisions]);

  const artifacts = selectedRevision ? Object.entries(selectedRevision.artifactUrls) : [];
  const downloads = downloadItems(artifacts);
  const needsRevision = view !== "parts";

  return (
    <Box component="aside" aria-label="Mission details" sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, bgcolor: "background.paper" }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: "divider", minHeight: 56 }}>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="panel-view-label">Show</InputLabel>
          <Select labelId="panel-view-label" label="Show" value={view} onChange={(e) => onViewChange(PANEL_VIEWS.find((v) => v === e.target.value) ?? view)}>
            {PANEL_VIEWS.map((v) => (
              <MenuItem key={v} value={v}>
                {PANEL_VIEW_LABELS[v]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {latest !== undefined && (
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
        <Tooltip title="Download design files">
          <span>
            <IconButton aria-label="Download design files" disabled={artifacts.length === 0} onClick={(e) => setDownloadAnchor(e.currentTarget)}>
              <DownloadIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Menu anchorEl={downloadAnchor} open={downloadAnchor !== null} onClose={() => setDownloadAnchor(null)}>
          {downloads.map((item, index) => (
            <Fragment key={item.key}>
              {(index === 0 || downloads[index - 1]?.group !== item.group) && <ListSubheader>{item.group}</ListSubheader>}
              <MenuItem component="a" href={item.url} download={`r${n}-${item.key}`} onClick={() => setDownloadAnchor(null)}>
                {item.label}
              </MenuItem>
            </Fragment>
          ))}
        </Menu>
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
        ) : view === "checks" ? (
          <ChecksView consoles={selectedRevision?.results.reports ?? []} focus={focus} />
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
            {view === "replay" && <ReplayTab revision={revision.data} />}
            {view === "telemetry" && <TelemetryTab missionId={missionId} revision={revision.data} />}
            {view === "diagnosis" && <DiagnosisView missionId={missionId} revision={revision.data} />}
            {view === "photos" && <PhotoTab revision={revision.data} />}
          </Suspense>
        )}
      </Box>
    </Box>
  );
}
