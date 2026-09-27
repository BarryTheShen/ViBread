import CelebrationIcon from "@mui/icons-material/Celebration";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { MissionDetail } from "@vibread/core";
import { useMemo } from "react";
import { Link as RouterLink } from "react-router";
import { HttpError } from "../api/client.js";
import { useConfirmMission, useRevision } from "../api/hooks.js";
import { benchPanelPath } from "./panelUrl.js";

function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>("main textarea, textarea")?.focus();
}

const rise = keyframes`
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(-70vh) rotate(540deg); opacity: 0; }
`;

/** /confirm 409 codes that mean "the bench must pass first" (ServerCore); their messages are already plain words. */
const BENCH_BLOCKERS: Record<string, true> = { bench_run_required: true, bench_run_failed: true, bench_run_incomplete: true };

/** Confetti colours come from the theme palette. */
const COLORS = ["primary.main", "secondary.main", "success.main", "warning.main", "info.main"];

/** Short confetti burst for DONE; replaced by a static badge when reduced motion is on. */
function Celebration() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pieces = useMemo(
    () => Array.from({ length: 40 }, (_, i) => ({ left: (i * 37) % 100, delay: (i % 10) * 0.12, color: COLORS[i % COLORS.length], size: 6 + (i % 4) * 2 })),
    [],
  );
  if (reducedMotion) return null;
  return (
    <Box aria-hidden sx={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: (t) => t.zIndex.snackbar }}>
      {pieces.map((p, i) => (
        <Box
          key={i}
          sx={{
            position: "absolute",
            bottom: -20,
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 1.6,
            bgcolor: p.color,
            borderRadius: 0.5,
            animation: `${rise} 2.6s ease-out ${p.delay}s 1 forwards`,
          }}
        />
      ))}
    </Box>
  );
}

/**
 * LAUNCH: the self-test passed and the real sketch runs — ask the person whether it does what they wanted.
 * DONE: mission complete, with a celebration.
 */
export function MissionCompleteCard({
  missionId,
  detail,
  onTellAgent = focusComposer,
}: {
  missionId: string;
  detail: MissionDetail;
  /** "Not quite — tell the agent": defaults to focusing the chat box. */
  onTellAgent?: () => void;
}) {
  const confirm = useConfirmMission(missionId);
  const phase = detail.mission.phase;
  const released = useRevision(missionId, phase === "LAUNCH" ? detail.mission.releasedRevision : undefined);
  const virtualBoard = released.data?.results.bench?.at(-1)?.runId.startsWith("virtual-") ?? false;
  if (phase === "DONE") {
    return (
      <>
        <Celebration />
        <Alert id="mission-complete-card" tabIndex={-1} severity="success" icon={<CelebrationIcon />} sx={{ my: 1, alignItems: "center" }}>
          <Typography sx={{ fontWeight: 700 }}>Mission complete. Your circuit works the way you wanted — well done, Flight!</Typography>
        </Alert>
      </>
    );
  }
  if (phase !== "LAUNCH") return null;
  // The server refuses completion on a virtual pass (409 real_board_required); treat that answer like a virtual run.
  const realBoardRequired = virtualBoard || (confirm.error instanceof HttpError && confirm.error.code === "real_board_required");
  if (realBoardRequired) {
    return (
      <Paper id="mission-complete-card" tabIndex={-1} variant="outlined" role="region" aria-label="Build it for real" sx={{ my: 1, p: 2, borderColor: "info.main", borderWidth: 2 }}>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
          <UsbIcon color="info" />
          <Typography variant="overline" sx={{ color: "info.main", lineHeight: 1.4 }}>
            Virtual board · passed
          </Typography>
        </Stack>
        <Typography variant="body1" sx={{ fontWeight: 600, mb: 1.5 }}>
          The virtual board passed. Build it for real and run the bench with your Arduino to complete the mission.
        </Typography>
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
          <Button component={RouterLink} to={benchPanelPath(missionId, "")} variant="contained" startIcon={<UsbIcon />}>
            Open the bench
          </Button>
          <Button component={RouterLink} to={`/b/${missionId}`} variant="outlined">
            Build steps
          </Button>
        </Stack>
      </Paper>
    );
  }
  return (
    <Paper id="mission-complete-card" tabIndex={-1} variant="outlined" role="region" aria-label="Does it work?" sx={{ my: 1, p: 2, borderColor: "success.main", borderWidth: 2 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
        <RocketLaunchIcon color="success" />
        <Typography variant="overline" sx={{ color: "success.main", lineHeight: 1.4 }}>
          Launched · the self-test passed
        </Typography>
      </Stack>
      <Typography variant="h6" component="p">
        Does it work the way you wanted?
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        Try it for real: your sketch is running on the board now.
      </Typography>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <Button variant="contained" color="success" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Saving…" : "Yes — mission complete"}
        </Button>
        <Button variant="outlined" onClick={onTellAgent}>
          Not quite — tell the agent
        </Button>
      </Stack>
      {confirm.isError &&
        (confirm.error instanceof HttpError && BENCH_BLOCKERS[confirm.error.code] ? (
          // The server wants a (passing) real bench run first: say so, with its own words, and point at the bench.
          <Alert
            severity={confirm.error.code === "bench_run_failed" ? "error" : "warning"}
            sx={{ mt: 1.5 }}
            action={
              <Button component={RouterLink} to={benchPanelPath(missionId, "")} size="small" sx={{ whiteSpace: "nowrap" }}>
                Open the bench
              </Button>
            }
          >
            <strong>{confirm.error.message}</strong>
          </Alert>
        ) : (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Couldn't save that: {confirm.error.message}
          </Alert>
        ))}
    </Paper>
  );
}
