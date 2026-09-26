import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import ReportProblemIcon from "@mui/icons-material/ReportProblem";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import type { MissionRecording, RevisionDetail, ScenarioCategory } from "@vibread/core";
import { RecordedChip } from "../../components/RecordedChip.js";

const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  normal: "everyday use",
  "power-on": "just switched on",
  bounce: "shaky button contact",
  rapid: "fast presses",
  threshold: "right at the switching point",
  hysteresis: "no flicker near the switching point",
  edge: "unusual case",
};

/** Simulation tests in plain language: what each checks, whether it passed, and what isn't covered yet. */
/** Recorded missions (MissionDetail.recording) replay a real run: say who wrote the tests and when, never "live". */
function recordedTestsLine(recording: MissionRecording | undefined): string | undefined {
  if (!recording) return undefined;
  const author = recording.models.testAuthor ?? "Claude";
  const on = new Date(`${recording.recordedOn}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Recorded: written by ${author} on ${on}`;
}

export function TestsTab({ revision, recording }: { revision: RevisionDetail; recording?: MissionRecording }) {
  const scenarios = revision.suite?.scenarios ?? [];
  const sim = revision.results.sim;
  const resultById = new Map((sim?.scenarios ?? []).map((s) => [s.id, s]));
  const intentById = new Map(revision.circuit.intent.map((c) => [c.id, c.text]));
  const passed = sim?.scenarios.filter((s) => s.ok).length ?? 0;

  if (scenarios.length === 0) {
    return <Alert severity="info">The independent test author hasn't written tests for this design yet.</Alert>;
  }
  return (
    <Stack sx={{ gap: 2 }}>
      <Box>
        <Typography variant="h3" component="h2">
          Simulation tests
        </Typography>
        <Typography sx={{ color: "text.secondary" }}>
          {sim
            ? `${passed} of ${sim.scenarios.length} tests pass in the simulator. A separate agent wrote these from your description, without seeing the code.`
            : "These tests haven't been run yet."}
        </Typography>
        {recording && (
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap", mt: 1 }}>
            <RecordedChip label="Recorded run" title={recording.label} />
            <Typography variant="body2">{recordedTestsLine(recording)}</Typography>
          </Stack>
        )}
      </Box>
      <List disablePadding>
        {scenarios.map((scenario) => {
          const result = resultById.get(scenario.id);
          const failedStep = result?.steps.find((s) => !s.ok);
          return (
            <ListItem key={scenario.id} disableGutters sx={{ alignItems: "flex-start", borderBottom: 1, borderColor: "divider", py: 1 }}>
              <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                {!result ? (
                  <HourglassEmptyIcon sx={{ color: "text.secondary" }} titleAccess="Not run" />
                ) : result.ok ? (
                  <CheckCircleIcon color="success" titleAccess="Passed" />
                ) : (
                  <CancelIcon color="error" titleAccess="Failed" />
                )}
              </ListItemIcon>
              <ListItemText
                primary={
                  <>
                    <Box component="span" sx={{ fontWeight: 600 }}>
                      {!result ? "Not run" : result.ok ? "Passed" : "Failed"}
                    </Box>
                    {" · "}
                    {scenario.title}
                  </>
                }
                secondary={
                  <>
                    {failedStep && (
                      <Box component="span" sx={{ display: "block", color: "error.light", mt: 0.5 }}>
                        What went wrong: {failedStep.message} (at {failedStep.atMs} ms)
                      </Box>
                    )}
                    <Box component="span" sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", alignItems: "center", mt: 0.75 }}>
                      <Box component="span" sx={{ fontSize: 12, mr: 0.5 }}>
                        Checks goal
                      </Box>
                      {scenario.clauses.map((c) => (
                        <Tooltip key={c} title={intentById.get(c) ?? c} describeChild>
                          <Chip size="small" variant="outlined" label={c} tabIndex={0} />
                        </Tooltip>
                      ))}
                      {scenario.categories.map((c) => (
                        <Chip key={c} size="small" label={CATEGORY_LABELS[c]} />
                      ))}
                    </Box>
                  </>
                }
                slotProps={{ secondary: { component: "div" } }}
              />
            </ListItem>
          );
        })}
      </List>
      {sim && (
        <Box>
          <Typography variant="overline" sx={{ color: "text.secondary" }}>
            Coverage
          </Typography>
          {sim.coverage.missing.length === 0 ? (
            <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
              <CheckCircleIcon color="success" fontSize="small" />
              <Typography>Every light, button, and sensor is tested, and every edge case the checker looks for is present.</Typography>
            </Stack>
          ) : (
            <List dense disablePadding>
              {sim.coverage.missing.map((gap) => (
                <ListItem key={gap} disableGutters>
                  <ListItemIcon sx={{ minWidth: 34 }}>
                    <ReportProblemIcon color="warning" fontSize="small" titleAccess="Gap" />
                  </ListItemIcon>
                  <ListItemText primary={`Not tested yet: ${gap}`} />
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      )}
    </Stack>
  );
}
