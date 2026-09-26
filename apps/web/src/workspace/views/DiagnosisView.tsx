import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { Attribution, RevisionDetail } from "@vibread/core";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import { useArtifactText } from "../../api/hooks.js";
import { decorateBreadboardSvg } from "../../bench/svg.js";
import { sanitizeSvg } from "../../lib/svg.js";

const ATTRIBUTION: Record<Attribution, string> = {
  wiring: "Wiring — something on the breadboard",
  code: "Code — the sketch",
  design: "Design — the circuit itself",
  component: "A part — it may be faulty or the wrong value",
  unknown: "Not sure yet",
  none: "No fault found",
};

/** The bench diagnosis: what failed, the likeliest causes, and the breadboard with the suspect holes/parts highlighted. */
export function DiagnosisView({ missionId, revision }: { missionId: string; revision: RevisionDetail }) {
  const run = revision.results.bench?.at(-1);
  const practice = run?.runId.startsWith("virtual-") ?? false;
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
      <Alert severity="info" action={<Button component={RouterLink} to={`/m/${missionId}/bench`} startIcon={<UsbIcon />} sx={{ whiteSpace: "nowrap" }}>Open the bench</Button>}>
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
        <Button variant="contained" component={RouterLink} to={`/m/${missionId}/bench`} startIcon={<UsbIcon />}>
          Fix and retest
        </Button>
      </Stack>
    </Stack>
  );
}
