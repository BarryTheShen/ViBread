import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { Attribution, BenchRunResult, BenchTestResult, RevisionDetail } from "@vibread/core";
import type { ReactElement } from "react";
import { Link as RouterLink } from "react-router";

const STATUS: Record<BenchTestResult["status"], { word: string; icon: ReactElement }> = {
  pass: { word: "Passed", icon: <CheckCircleIcon color="success" fontSize="small" /> },
  fail: { word: "Failed", icon: <CancelIcon color="error" fontSize="small" /> },
  unknown: { word: "Unclear", icon: <HelpOutlineIcon color="warning" fontSize="small" /> },
  skipped: { word: "Skipped", icon: <RemoveCircleOutlineIcon sx={{ color: "text.secondary" }} fontSize="small" /> },
};

const KIND: Record<BenchRunResult["kind"], string> = {
  rails: "Power rails check",
  checkpoint: "Checkpoint",
  selftest: "Full self-test",
};

const ATTRIBUTION: Record<Attribution, string> = {
  design: "The design needs a change",
  code: "The code needs a change",
  wiring: "A wire or part is in the wrong place",
  component: "A part may be faulty",
  unknown: "Cause not certain yet",
  none: "Nothing wrong found",
};

/** Plain question the person didn't answer in time: from the diagnosis summary, else from the test that went unanswered. */
function timedOutPrompt(run: BenchRunResult): string | undefined {
  const quoted = /Nobody answered '([^']+)' in time/.exec(run.diagnosis.summary);
  if (quoted) return `Nobody answered “${quoted[1]}” in time.`;
  const unanswered = run.results.find((r) => r.subjects.some((s) => /timed out/.test(s.observed)));
  if (!unanswered) return undefined;
  const question: Partial<Record<BenchTestResult["test"], string>> = {
    "button.interactive": "Press the button",
    "led.sequence": "Which light is blinking",
    "light.relative": "Cover the light sensor",
    "pot.sweep": "Turn the knob",
    "buzzer.confirm": "Listen for the beep",
  };
  const words = question[unanswered.test];
  return words ? `Nobody answered “${words}” in time.` : "One of the bench questions wasn't answered in time.";
}

function RunCard({ run }: { run: BenchRunResult }) {
  const verdict =
    run.verdict === "pass"
      ? { label: "Passed", color: "success" as const, icon: <CheckCircleIcon /> }
      : run.verdict === "fail"
        ? { label: "Problem found", color: "error" as const, icon: <CancelIcon /> }
        : { label: "Incomplete", color: "warning" as const, icon: <HelpOutlineIcon /> };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1 }}>
        <Typography variant="h6" component="h3" sx={{ flex: 1 }}>
          {KIND[run.kind]} · design r{run.revision}
        </Typography>
        <Chip icon={verdict.icon} color={verdict.color} label={verdict.label} />
      </Stack>
      {run.verdict === "incomplete" ? (
        // An unfinished run proves nothing about the wiring: no causes, no fixes — just what was missed and what to do.
        <Alert severity="warning" sx={{ mb: 1 }}>
          <strong>The self-test didn't finish.</strong> {timedOutPrompt(run) ?? "The board stopped sending results before the end."} Nothing was
          judged about your wiring. Run the self-test again and answer each question on the bench screen.
        </Alert>
      ) : (
        run.diagnosis.summary && (
          <Alert severity={run.verdict === "pass" ? "success" : "error"} sx={{ mb: 1 }}>
            <strong>{ATTRIBUTION[run.diagnosis.attribution]}.</strong> {run.diagnosis.summary}
          </Alert>
        )
      )}
      {run.verdict === "fail" && run.diagnosis.candidates.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="overline" sx={{ color: "text.secondary" }}>
            Most likely causes
          </Typography>
          <List dense disablePadding>
            {run.diagnosis.candidates.map((c) => (
              <ListItem key={c.cause} disableGutters sx={{ alignItems: "flex-start" }}>
                <Chip size="small" label={`${Math.round(c.likelihood * 100)}%`} sx={{ mr: 1, mt: 0.5 }} />
                <ListItemText primary={c.title} secondary={`Fix: ${c.fix}`} />
              </ListItem>
            ))}
          </List>
        </Box>
      )}
      <Typography variant="overline" sx={{ color: "text.secondary" }}>
        What the board reported
      </Typography>
      <List dense disablePadding>
        {run.results.map((r) => (
          <ListItem key={r.test} disableGutters sx={{ alignItems: "flex-start" }}>
            <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>{STATUS[r.status].icon}</ListItemIcon>
            <ListItemText
              primary={`${STATUS[r.status].word} · ${r.summary}`}
              secondary={r.subjects
                .filter((s) => s.status !== "pass")
                .map((s) => `${s.part} on ${s.pin}: expected ${s.expected}, saw ${s.observed}`)
                .join(" · ") || undefined}
            />
          </ListItem>
        ))}
      </List>
      {run.calibration.length > 0 && (
        <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
          Light sensor calibrated: {run.calibration.map((c) => `${c.part} switches at ${Math.round(c.threshold)} (room ${Math.round(c.ambient)}, covered ${Math.round(c.covered)}, on a 0–1023 scale)`).join("; ")}
        </Typography>
      )}
    </Paper>
  );
}

export function TelemetryTab({ missionId, revision }: { missionId: string; revision: RevisionDetail }) {
  const runs = [...(revision.results.bench ?? [])].reverse();
  return (
    <Stack sx={{ gap: 2 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          Bench results
        </Typography>
        <Button component={RouterLink} to={`/m/${missionId}/bench`} variant="outlined" startIcon={<UsbIcon />}>
          Open the bench
        </Button>
      </Stack>
      {runs.length === 0 ? (
        <Alert severity="info">No bench runs yet. Plug in your board at the bench to run the self-test.</Alert>
      ) : (
        runs.map((run) => <RunCard key={run.runId} run={run} />)
      )}
    </Stack>
  );
}
