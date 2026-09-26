import FlightTakeoffIcon from "@mui/icons-material/FlightTakeoff";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { ConsoleId, MissionDetail } from "@vibread/core";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { HttpError } from "../api/client.js";
import { useConnections, useRelease } from "../api/hooks.js";

const REQUIRED: ConsoleId[] = ["EECOM", "GUIDO", "FIDO", "FAO"];

/** Where "GO for build" stands for the mission's current revision (PLAN §5.4 Go/No-Go poll). */
export function releaseReadiness(detail: MissionDetail): {
  revision?: number;
  released: boolean;
  allRequiredGo: boolean;
  retroMissing: boolean;
  blocking: ConsoleId[];
} {
  const revision = detail.revision?.n;
  const verdict = (id: ConsoleId) => detail.consoles.find((c) => c.console === id)?.verdict;
  const blocking = REQUIRED.filter((id) => verdict(id) !== "GO");
  const retro = verdict("RETRO");
  return {
    revision,
    released: revision !== undefined && detail.mission.releasedRevision === revision,
    allRequiredGo: revision !== undefined && blocking.length === 0 && retro !== "NO-GO",
    retroMissing: retro === undefined || retro === "PENDING" || retro === "SKIPPED",
    blocking,
  };
}

/** Flight Director's "GO for build" on the console bar: the human release of a revision as the build target. */
export function FlightDirector({ missionId, detail }: { missionId: string; detail: MissionDetail }) {
  const release = useRelease(missionId);
  const connections = useConnections();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const state = releaseReadiness(detail);
  const phoneUrl = `${window.location.origin}/b/${missionId}`;

  const go = (acknowledgeMissingReview: boolean) =>
    state.revision !== undefined &&
    release.mutate(
      { revision: state.revision, acknowledgeMissingReview },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          setToastOpen(true);
        },
        // The server is the authority on whether RETRO voted; if it says the review is missing, ask the person.
        onError: (error) => {
          if (error instanceof HttpError && error.code === "retro_missing") {
            release.reset();
            setConfirmOpen(true);
          }
        },
      },
    );

  // FIDO waits for tests the (AI) test author writes; without any Claude credential that never happens by itself.
  const fidoPending = detail.consoles.find((c) => c.console === "FIDO")?.verdict === "PENDING";
  const noAgent = connections.data?.claude?.using === "none";
  const testsBlocked = state.blocking.includes("FIDO") && fidoPending;
  const reason = state.revision === undefined
    ? "There's no design yet."
    : testsBlocked && noAgent
      ? "Simulation tests (FIDO) haven't been written yet: an AI agent writes them, and no Claude account or key is connected. Connect one in Settings → Connect your Claude account."
      : testsBlocked
        ? "Simulation tests (FIDO) are still being written for this design."
        : state.blocking.length > 0
          ? `Waiting for GO from: ${state.blocking.join(", ")}.`
          : "Every check says GO.";

  return (
    <>
      {state.released ? (
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexShrink: 0 }}>
          <Button component={RouterLink} to={`/b/${missionId}`} variant="outlined" startIcon={<PhoneIphoneIcon />} sx={{ minHeight: 48 }}>
            Build r{state.revision}
          </Button>
        </Stack>
      ) : (
        <Tooltip title={reason} describeChild>
          <span style={{ flexShrink: 0 }}>
            <Button
              variant="contained"
              color="success"
              size="large"
              startIcon={<FlightTakeoffIcon />}
              disabled={!state.allRequiredGo || release.isPending}
              onClick={() => (state.retroMissing ? setConfirmOpen(true) : go(false))}
              sx={{ minHeight: 48, fontWeight: 800, whiteSpace: "nowrap" }}
            >
              {release.isPending ? "Releasing…" : state.revision !== undefined ? `GO for build · r${state.revision}` : "GO for build"}
            </Button>
          </span>
        </Tooltip>
      )}
      {!state.released && testsBlocked && noAgent && (
        <Button component={RouterLink} to="/settings" size="small" aria-label="Connect Claude in Settings so the tests can be written" sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>
          Connect Claude
        </Button>
      )}
      {release.isError && !confirmOpen && (
        <Snackbar open autoHideDuration={6000} onClose={() => release.reset()} message={`Couldn't release: ${release.error.message}`} />
      )}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>GO for build without the independent review?</DialogTitle>
        <DialogContent dividers>
          <Typography sx={{ mb: 1 }}>
            Electrical checks, firmware, simulation tests, and assembly all say <strong>GO</strong> for design r{state.revision}.
          </Typography>
          <Typography sx={{ mb: 1 }}>
            The <strong>independent review (RETRO)</strong> hasn't voted: it's done by the AI agent, and the agent isn't connected on this server.
            Releasing now means you accept the design on the other four checks alone.
          </Typography>
          <Typography sx={{ color: "text.secondary" }}>
            Nothing touches your board yet: you'll build it step by step, and the bench self-test checks the real wiring.
          </Typography>
          {release.isError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              Couldn't release: {release.error.message}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Not yet</Button>
          <Button variant="contained" color="success" disabled={release.isPending} onClick={() => go(true)}>
            {release.isPending ? "Releasing…" : "GO for build without review"}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={toastOpen}
        onClose={(_, why) => why !== "clickaway" && setToastOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert severity="success" variant="filled" onClose={() => setToastOpen(false)} icon={<FlightTakeoffIcon />} sx={{ alignItems: "center" }}>
          <Stack direction="row" sx={{ gap: 2, alignItems: "center" }}>
            <Box sx={{ bgcolor: "#fff", p: 0.5, borderRadius: 1, lineHeight: 0 }}>
              <QRCodeSVG value={phoneUrl} size={88} title="QR code for Build Mode on your phone" />
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 700 }}>GO for build! Design r{state.revision} is the build target.</Typography>
              <Stack direction="row" sx={{ gap: 1, mt: 1, flexWrap: "wrap" }}>
                <Button component={RouterLink} to={`/b/${missionId}`} variant="contained" size="small" startIcon={<PhoneIphoneIcon />} sx={{ bgcolor: "#fff", color: "#03170a", "&:hover": { bgcolor: "#e6f4ea" } }}>
                  Open Build Mode on your phone
                </Button>
                <Button component={RouterLink} to={`/m/${missionId}/bench`} variant="outlined" color="inherit" size="small" startIcon={<UsbIcon />}>
                  Open the bench
                </Button>
              </Stack>
            </Box>
          </Stack>
        </Alert>
      </Snackbar>
    </>
  );
}
