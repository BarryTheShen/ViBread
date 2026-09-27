import FlightTakeoffIcon from "@mui/icons-material/FlightTakeoff";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { MissionDetail } from "@vibread/core";
import { useState } from "react";
import { HttpError } from "../api/client.js";
import { useConnections, useRelease } from "../api/hooks.js";
import { releaseReadiness } from "./nextStep.js";
import { OVERRIDE_CODES, overrideReasons } from "./overrideReasons.js";

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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [understood, setUnderstood] = useState(false);
  const state = releaseReadiness(detail);
  const releaseError = release.error instanceof HttpError ? release.error : undefined;
  const bypassed = overrideReasons(detail, releaseError);

  const openOverride = () => {
    setConfirmOpen(false);
    setOverrideReason("");
    setUnderstood(false);
    setOverrideOpen(true);
  };
  const go = (acknowledgeMissingReview: boolean, reason?: string) => {
    if (state.revision === undefined) return;
    const trimmedReason = reason?.trim();
    release.mutate(
      { revision: state.revision, acknowledgeMissingReview, ...(reason !== undefined ? { override: trimmedReason ? { reason: trimmedReason } : {} } : {}) },
      {
        onSuccess: (released) => {
          setConfirmOpen(false);
          setOverrideOpen(false);
          release.reset();
          onReleased(released.mission.releasedRevision ?? state.revision ?? 1);
        },
        onError: (error) => {
          // retro_missing first: the review-waiver confirm (it offers the override too) must not become a full bypass.
          if (error instanceof HttpError && error.code === "retro_missing") {
            release.reset();
            setConfirmOpen(true);
          } else if (error instanceof HttpError && OVERRIDE_CODES[error.code] === true) {
            setConfirmOpen(false);
            setOverrideOpen(true);
          }
        },
      },
    );
  };

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
              disabled={state.revision === undefined || state.released || release.isPending}
              // A blocked click lets the server explain the exact gate; the override action then remains explicit.
              onClick={() => (state.retroMissing && !onlyTestsMissing ? setConfirmOpen(true) : go(false))}
              sx={{ whiteSpace: "nowrap", fontWeight: 700 }}
            >
              {release.isPending ? "Releasing…" : "GO for build"}
            </Button>
          </span>
        </Tooltip>
      </Stack>
      {release.isError && !confirmOpen && !overrideOpen && (
        <Snackbar
          open
          autoHideDuration={6000}
          onClose={() => release.reset()}
          message={releaseError?.code === "tests_missing" ? releaseError.message : `Couldn't release: ${release.error.message}`}
          action={releaseError && OVERRIDE_CODES[releaseError.code] === true ? <Button color="error" variant="outlined" size="small" onClick={openOverride}>Override — I know what I'm doing</Button> : undefined}
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
        </DialogContent>
        {/* Three actions don't fit one row in a small dialog: wrap whole buttons, never their labels ("Not / yet"), and
            keep each wrapped row right-aligned with the primary action last. Focus starts on the safe choice. */}
        <DialogActions sx={{ flexWrap: "wrap", justifyContent: "flex-end", gap: 1, "& > :not(style) ~ :not(style)": { ml: 0 }, "& .MuiButton-root": { whiteSpace: "nowrap" } }}>
          <Button onClick={() => setConfirmOpen(false)} autoFocus>Not yet</Button>
          <Button color="error" variant="outlined" onClick={openOverride}>Override — I know what I'm doing</Button>
          <Button variant="contained" disabled={release.isPending} onClick={() => go(true)}>
            {release.isPending ? "Releasing…" : "GO for build without review"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={overrideOpen} onClose={() => setOverrideOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Override GO for build?</DialogTitle>
        <DialogContent dividers>
          <Typography sx={{ mb: 1 }}>You are choosing to bypass exactly these checks:</Typography>
          <List dense disablePadding sx={{ mb: 1, listStyleType: "disc" }}>
            {bypassed.map((item) => <ListItem key={item} disableGutters sx={{ display: "list-item", ml: 2 }}>{item}</ListItem>)}
          </List>
          {releaseError && <Alert severity="warning" sx={{ mb: 1.5 }}>Server gate: {releaseError.message}</Alert>}
          <TextField
            label="Reason (optional)"
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            helperText={`${overrideReason.length}/200`}
            fullWidth
            size="small"
          />
          <FormControlLabel
            control={<Checkbox checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />}
            label="I understand ViBread won't check this for me"
            sx={{ mt: 1 }}
          />
          <Typography variant="body2" color="text.secondary">The revision's real verdicts stay unchanged. The override is recorded in the mission timeline.</Typography>
        </DialogContent>
        <DialogActions sx={{ flexWrap: "wrap", justifyContent: "flex-end", gap: 1, "& > :not(style) ~ :not(style)": { ml: 0 }, "& .MuiButton-root": { whiteSpace: "nowrap" } }}>
          <Button onClick={() => setOverrideOpen(false)} autoFocus>Cancel</Button>
          <Button color="error" variant="outlined" disabled={!understood || release.isPending} onClick={() => go(false, overrideReason)}>
            {release.isPending ? "Releasing…" : "Override and GO for build"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
