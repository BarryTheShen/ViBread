import FlightTakeoffIcon from "@mui/icons-material/FlightTakeoff";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { MissionDetail } from "@vibread/core";
import { useState } from "react";
import { HttpError } from "../api/client.js";
import { useConnections, useRelease } from "../api/hooks.js";
import { releaseReadiness } from "./nextStep.js";

/**
 * The header's "GO for build" (the Flight Director's release of a revision as the build target). Same rules as before:
 * the four deterministic consoles must be GO; a review that couldn't run needs the "without review" waiver; with a
 * Claude credential and only the tests missing, the server writes the tests first. `onReleased` gets the revision the
 * server actually released (it may be n+1 when it wrote the missing tests).
 */
export function GoForBuildButton({ missionId, detail, onReleased }: { missionId: string; detail: MissionDetail; onReleased(revision: number): void }) {
  const release = useRelease(missionId);
  const connections = useConnections();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const state = releaseReadiness(detail);

  const go = (acknowledgeMissingReview: boolean) =>
    state.revision !== undefined &&
    release.mutate(
      { revision: state.revision, acknowledgeMissingReview },
      {
        onSuccess: (released) => {
          setConfirmOpen(false);
          onReleased(released.mission.releasedRevision ?? state.revision ?? 1);
        },
        // The server is the authority on whether the review voted; if it says it's missing, ask the person.
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
  const onlyTestsMissing = testsBlocked && state.blocking.length === 1;
  const reason =
    state.revision === undefined
      ? "There's no design yet."
      : testsBlocked && noAgent
        ? "Simulation tests (FIDO) haven't been written yet: an AI agent writes them, and no Claude account or key is connected. Connect one in Settings → Connect your Claude account."
        : onlyTestsMissing
          ? "The simulation tests aren't written yet. Press GO for build and the agent writes and runs them first (this can take a minute)."
          : testsBlocked
            ? "Simulation tests (FIDO) are still being written for this design."
            : state.blocking.length > 0
              ? `Waiting for GO from: ${state.blocking.join(", ")}.`
              : "Every check says GO.";

  return (
    <>
      <Stack direction="row" sx={{ gap: 0.5, alignItems: "center", flexShrink: 0 }}>
        <Tooltip title={reason} describeChild>
          <span>
            <Button
              variant="contained"
              startIcon={<FlightTakeoffIcon />}
              disabled={!(state.allRequiredGo || (onlyTestsMissing && !noAgent)) || release.isPending}
              // With only the tests missing and a credential, the review can only run after the server writes them:
              // send GO directly; a later retro_missing answer still opens the dialog.
              onClick={() => (state.retroMissing && !onlyTestsMissing ? setConfirmOpen(true) : go(false))}
              sx={{ whiteSpace: "nowrap", fontWeight: 700 }}
            >
              {release.isPending ? "Releasing…" : "GO for build"}
            </Button>
          </span>
        </Tooltip>
      </Stack>
      {release.isError && !confirmOpen && (
        <Snackbar
          open
          autoHideDuration={6000}
          onClose={() => release.reset()}
          message={release.error instanceof HttpError && release.error.code === "tests_missing" ? release.error.message : `Couldn't release: ${release.error.message}`}
        />
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
          <Button variant="contained" disabled={release.isPending} onClick={() => go(true)}>
            {release.isPending ? "Releasing…" : "GO for build without review"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
