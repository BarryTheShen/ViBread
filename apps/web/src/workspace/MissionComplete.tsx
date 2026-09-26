import CelebrationIcon from "@mui/icons-material/Celebration";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { MissionPhase } from "@vibread/core";
import { useMemo } from "react";
import { useConfirmMission } from "../api/hooks.js";

const rise = keyframes`
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(-70vh) rotate(540deg); opacity: 0; }
`;

const COLORS = ["#7dd3fc", "#fbbf24", "#4ade80", "#f87171", "#eef4fa"];

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
export function MissionComplete({ missionId, phase, onTellAgent }: { missionId: string; phase: MissionPhase; onTellAgent(): void }) {
  const confirm = useConfirmMission(missionId);
  if (phase === "DONE") {
    return (
      <>
        <Celebration />
        <Alert severity="success" icon={<CelebrationIcon />} sx={{ mx: 2, mt: 1, alignItems: "center" }}>
          <Typography sx={{ fontWeight: 700 }}>Mission complete. Your circuit works the way you wanted — well done, Flight!</Typography>
        </Alert>
      </>
    );
  }
  if (phase !== "LAUNCH") return null;
  return (
    <Paper variant="outlined" role="region" aria-label="Does it work?" sx={{ mx: 2, mt: 1, p: 2, borderColor: "success.main", borderWidth: 2 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
        <RocketLaunchIcon color="success" />
        <Typography variant="overline" sx={{ color: "success.main", lineHeight: 1.4 }}>
          Launched · the self-test passed
        </Typography>
      </Stack>
      <Typography variant="h3" component="p">
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
      {confirm.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          Couldn't save that: {confirm.error.message}
        </Alert>
      )}
    </Paper>
  );
}
