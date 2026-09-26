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
        <Typography variant="h3" component="h3" sx={{ flex: 1 }}>
          {KIND[run.kind]} · design r{run.revision}
        </Typography>
        <Chip icon={verdict.icon} color={verdict.color} label={verdict.label} />
      </Stack>
      {run.diagnosis.summary && (
        <Alert severity={run.verdict === "pass" ? "success" : run.verdict === "fail" ? "error" : "warning"} sx={{ mb: 1 }}>
          <strong>{ATTRIBUTION[run.diagnosis.attribution]}.</strong> {run.diagnosis.summary}
        </Alert>
      )}
      {run.diagnosis.candidates.length > 0 && (
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
          Light sensor calibrated: {run.calibration.map((c) => `${c.part} switches at ${c.threshold} (room ${c.ambient}, covered ${c.covered})`).join("; ")}
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
        <Typography variant="h3" component="h2" sx={{ flex: 1 }}>
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
