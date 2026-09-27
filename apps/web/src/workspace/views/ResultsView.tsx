import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
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
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { isPracticeRun, type Attribution, type BenchRunResult, type BenchTestResult, type RevisionDetail } from "@vibread/core";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import { useArtifactText } from "../../api/hooks.js";
import { decorateBreadboardSvg } from "../../bench/svg.js";
import { sanitizeSvg } from "../../lib/svg.js";
import { benchPanelPath } from "../panelUrl.js";

/*
 * "Bench results" (issue #24 merged the former Telemetry and Diagnosis views): both read the same bench runs. The latest
 * run's diagnosis comes first (breadboard with the suspect spots, likeliest causes); then what the board reported in every
 * run, newest first.
 */

const ATTRIBUTION: Record<Attribution, string> = {
  wiring: "Wiring — something on the breadboard",
  code: "Code — the sketch",
  design: "Design — the circuit itself",
  component: "A part — it may be faulty or the wrong value",
  unknown: "Not sure yet",
  none: "No fault found",
};

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

const RUN_ATTRIBUTION: Record<Attribution, string> = {
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

/** One bench run: verdict, summary, (causes unless shown above) and every test the board reported. */
function RunCard({ run, causes }: { run: BenchRunResult; causes: boolean }) {
  const practice = isPracticeRun(run);
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
        {practice && <Chip size="small" variant="outlined" label="Virtual board · self-test (practice)" />}
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
            <strong>{RUN_ATTRIBUTION[run.diagnosis.attribution]}.</strong> {run.diagnosis.summary}
          </Alert>
        )
      )}
      {causes && run.verdict === "fail" && run.diagnosis.candidates.length > 0 && (
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

/** The latest run's diagnosis: what failed, the likeliest causes, and the breadboard with the suspect spots highlighted. */
function LatestDiagnosis({ revision, run, benchHref }: { revision: RevisionDetail; run: BenchRunResult | undefined; benchHref: string }) {
  const practice = run !== undefined && isPracticeRun(run);
  const [picked, setPicked] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const boardUrl = revision.artifactUrls["breadboard.svg"];
  const board = useArtifactText(run && run.verdict !== "pass" ? boardUrl : undefined);
  const candidate = run?.diagnosis.candidates[picked];
  const markup = useMemo(() => {
    if (!board.data) return undefined;
    try {
      return sanitizeSvg(decorateBreadboardSvg(board.data, candidate?.highlight));
    } catch {
      return undefined;
    }
  }, [board.data, candidate]);

  if (!run) {
    return (
      <Alert severity="info" action={<Button component={RouterLink} to={benchHref} startIcon={<UsbIcon />} sx={{ whiteSpace: "nowrap" }}>Open the bench</Button>}>
        No bench test on design r{revision.n} yet. When a bench test fails, the likely cause shows up here with the spot on the breadboard.
      </Alert>
    );
  }
  if (run.verdict === "pass") {
    return (
      <Alert severity="success">
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Typography component="span">The last bench test on design r{revision.n} passed: nothing to diagnose.</Typography>
          {practice && <Chip size="small" variant="outlined" label="Virtual board · self-test (practice)" />}
        </Stack>
      </Alert>
    );
  }
  const failed = run.results.filter((r) => r.status !== "pass");
  return (
    <Stack sx={{ gap: 2 }}>
      <Alert severity={run.verdict === "fail" ? "error" : "warning"} icon={<BuildCircleOutlinedIcon />}>
        <Typography sx={{ fontWeight: 600 }}>{run.diagnosis.summary || (run.verdict === "incomplete" ? "The bench test didn't finish." : "The bench test failed.")}</Typography>
        <Stack direction="row" sx={{ gap: 1, mt: 0.5, flexWrap: "wrap" }}>
          <Chip size="small" variant="outlined" label={`Likely: ${ATTRIBUTION[run.diagnosis.attribution]}`} />
          {practice && <Chip size="small" variant="outlined" label="Virtual board · self-test (practice)" />}
          {failed.length > 0 && <Chip size="small" variant="outlined" label={`${failed.length} test${failed.length === 1 ? "" : "s"} not passing`} />}
        </Stack>
      </Alert>
      {boardUrl &&
        (markup ? (
          // Breadboard drawings are dark canvases in every theme; the suspect spots are outlined, not just recoloured.
          <Box
            role="img"
            aria-label={candidate ? `Breadboard with the spots for “${candidate.title}” highlighted` : "Breadboard"}
            sx={{
              p: 1,
              bgcolor: "canvas.main",
              borderRadius: 1,
              border: 1,
              borderColor: "divider",
              "& svg": { display: "block", width: "100%", height: "auto", maxHeight: "50vh" },
              "& .vb-hl": { stroke: "var(--mui-palette-error-light)", strokeWidth: 6, strokeDasharray: "8 4", filter: "drop-shadow(0 0 6px var(--mui-palette-error-main))" },
              // Suspect jumpers/parts are redrawn in the error colour; suspect holes grow and fill so they read at panel size (Chrome supports CSS `r` on SVG circles).
              "& .vb-hl path": { stroke: "var(--mui-palette-error-light) !important", strokeWidth: "6px !important" },
              "& circle.vb-hl": { r: 7, fill: "var(--mui-palette-error-main) !important", stroke: "var(--mui-palette-error-light) !important", strokeDasharray: "none", strokeWidth: 2 },
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : board.isPending ? (
          <Skeleton variant="rounded" height={260} aria-label="Loading the breadboard" />
        ) : null)}
      {run.diagnosis.candidates.length > 0 && (
        <Paper variant="outlined">
          <Typography variant="overline" sx={{ px: 2, pt: 1, display: "block", color: "text.secondary" }}>
            Possible causes, likeliest first
          </Typography>
          <List dense disablePadding>
            {run.diagnosis.candidates.slice(0, showAll ? undefined : 3).map((c, i) => (
              <ListItemButton key={c.cause} selected={i === picked} onClick={() => setPicked(i)} sx={{ alignItems: "flex-start" }}>
                <ListItemText primary={`${Math.round(c.likelihood * 100)}% · ${c.title}`} secondary={`Fix: ${c.fix}`} />
              </ListItemButton>
            ))}
          </List>
          {run.diagnosis.candidates.length > 3 && (
            <Button size="small" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} sx={{ m: 1 }}>
              {showAll ? "Show fewer" : `Show ${run.diagnosis.candidates.length - 3} less likely causes`}
            </Button>
          )}
        </Paper>
      )}
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <Button variant="contained" component={RouterLink} to={benchHref} startIcon={<UsbIcon />}>
          Fix and retest
        </Button>
      </Stack>
    </Stack>
  );
}

export function ResultsView({ missionId, revision }: { missionId: string; revision: RevisionDetail }) {
  const runs = [...(revision.results.bench ?? [])].reverse();
  // Practice is useful history, but a later virtual run must not replace the real board's diagnosis.
  const latest = runs.find((run) => !isPracticeRun(run)) ?? runs[0];
  const benchHref = benchPanelPath(missionId, "");
  return (
    <Stack sx={{ gap: 2 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
          Bench results
        </Typography>
        <Button component={RouterLink} to={benchHref} variant="outlined" startIcon={<UsbIcon />}>
          Open the bench
        </Button>
      </Stack>
      <LatestDiagnosis revision={revision} run={latest} benchHref={benchHref} />
      {runs.length > 0 && (
        <Typography variant="overline" sx={{ color: "text.secondary", mb: -1 }}>
          What the board reported · {runs.length} run{runs.length === 1 ? "" : "s"}, newest first
        </Typography>
      )}
      {/* The latest run's causes are already listed in its diagnosis above. */}
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} causes={run !== latest} />
      ))}
    </Stack>
  );
}
