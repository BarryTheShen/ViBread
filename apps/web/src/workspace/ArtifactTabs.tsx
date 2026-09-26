import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { MissionDetail } from "@vibread/core";
import { lazy, Suspense, useEffect, useState } from "react";
import { useRevision, useRevisions } from "../api/hooks.js";
import { PhotoTab } from "./tabs/PhotoTab.js";
import { ReplayTab } from "./tabs/ReplayTab.js";
import { SchematicTab } from "./tabs/SchematicTab.js";
import { StepsTab } from "./tabs/StepsTab.js";
import { TelemetryTab } from "./tabs/TelemetryTab.js";
import { TestsTab } from "./tabs/TestsTab.js";
import { TryItTab } from "./tabs/TryItTab.js";

const CodeTab = lazy(() => import("./tabs/CodeTab.js").then((m) => ({ default: m.CodeTab })));

const TABS = [
  { id: "schematic", label: "Schematic" },
  { id: "steps", label: "Steps" },
  { id: "code", label: "Code" },
  { id: "tests", label: "Tests" },
  { id: "tryit", label: "Try it" },
  { id: "replay", label: "Replay" },
  { id: "telemetry", label: "Telemetry" },
  { id: "photo", label: "Photo" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ArtifactTabs({ missionId, detail }: { missionId: string; detail: MissionDetail }) {
  const [tab, setTab] = useState<TabId>("schematic");
  const latest = detail.mission.currentRevision;
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const n = picked ?? latest;
  const revisions = useRevisions(missionId);
  const revision = useRevision(missionId, n);
  const released = detail.mission.releasedRevision;

  // Follow new revisions as the agent makes them, unless the person picked an older one on purpose.
  useEffect(() => {
    if (picked !== undefined && picked === latest) setPicked(undefined);
  }, [latest, picked]);
  const refetchRevisions = revisions.refetch;
  useEffect(() => {
    if (latest !== undefined) void refetchRevisions();
  }, [latest, refetchRevisions]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, px: 1.5, pt: 1 }}>
        <Typography variant="overline" sx={{ color: "text.secondary", flex: 1 }}>
          Design files
        </Typography>
        {latest !== undefined && (
          <FormControl size="small" sx={{ minWidth: 190 }}>
            <InputLabel id="revision-select-label">Design version</InputLabel>
            <Select
              labelId="revision-select-label"
              label="Design version"
              value={n ?? ""}
              onChange={(e) => setPicked(Number(e.target.value))}
            >
              {(revisions.data ?? [{ n: latest }]).map((r) => (
                <MenuItem key={r.n} value={r.n}>
                  r{r.n}
                  {r.n === latest ? " · latest" : ""}
                  {r.n === released ? " · build target" : ""}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>
      <Tabs
        value={tab}
        onChange={(_, v: TabId) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Design files"
        sx={{ borderBottom: 1, borderColor: "divider", px: 1 }}
      >
        {TABS.map((t) => (
          <Tab key={t.id} value={t.id} label={t.label} id={`artifact-tab-${t.id}`} aria-controls={`artifact-panel-${t.id}`} />
        ))}
      </Tabs>
      {revision.isFetching && <LinearProgress aria-label="Loading design" sx={{ height: 2 }} />}
      <Box
        role="tabpanel"
        id={`artifact-panel-${tab}`}
        aria-labelledby={`artifact-tab-${tab}`}
        sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}
      >
        {latest === undefined ? (
          <Alert severity="info">
            Nothing to show yet. When the agent proposes a design, its schematic, code, tests, and build steps appear here.
          </Alert>
        ) : revision.isError ? (
          <Alert severity="error">Couldn't load design r{n}: {revision.error.message}</Alert>
        ) : !revision.data ? null : (
          <Suspense fallback={<LinearProgress />}>
            {tab === "schematic" && <SchematicTab revision={revision.data} />}
            {tab === "steps" && <StepsTab missionId={missionId} revision={revision.data} released={revision.data.n === released} />}
            {tab === "code" && <CodeTab revision={revision.data} />}
            {tab === "tests" && <TestsTab revision={revision.data} recording={detail.recording} />}
            {tab === "tryit" && <TryItTab revision={revision.data} />}
            {tab === "replay" && <ReplayTab revision={revision.data} />}
            {tab === "telemetry" && <TelemetryTab missionId={missionId} revision={revision.data} />}
            {tab === "photo" && <PhotoTab revision={revision.data} />}
          </Suspense>
        )}
      </Box>
    </Box>
  );
}
