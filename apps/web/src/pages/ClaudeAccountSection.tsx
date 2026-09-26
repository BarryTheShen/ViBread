import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClaudeAccountView, ConnectionsView } from "@vibread/core";
import { useState } from "react";
import { api, HttpError } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";

const USING: Record<ClaudeAccountView["using"], string> = {
  "claude-account": "Your missions use your Claude account.",
  "server-key": "Right now your missions use ViBread's own Claude key.",
  none: "Right now nothing powers the AI agent: connect a Claude account to use it.",
};

/** Plain-language messages for the server's Claude-login error codes. */
const ERRORS: Record<string, string> = {
  login_failed: "Claude didn't accept that code, so this sign-in has ended. Click Connect to start a new one, then paste the newest code (or the whole address).",
  login_not_found: "That sign-in expired or was already used. Click Connect to start a new one.",
  login_busy: "A sign-in is already in progress. Finish or cancel it first.",
  claude_account_unknown: "Signed in, but ViBread couldn't tell which Claude account it was. Try connecting again.",
  omp_unavailable: "The Claude connection service isn't running on this server right now. Try again in a minute.",
};

function friendly(error: Error): string {
  if (error instanceof HttpError && ERRORS[error.code]) return ERRORS[error.code];
  return error.message;
}

/** PLAN item 16 — "Connect your Claude account" (oh-my-pi's Claude login, driven by the server). */
export function ClaudeAccountSection() {
  const qc = useQueryClient();
  // Poll while a sign-in is pending: on the server's own machine the login finishes by itself (localhost callback).
  const connections = useQuery({
    queryKey: queryKeys.connections,
    queryFn: ({ signal }) => api.connections(signal),
    refetchInterval: (query) => (query.state.data?.claude?.pending ? 3_000 : false),
  });
  const setClaude = (claude: ClaudeAccountView) =>
    qc.setQueryData<ConnectionsView>(queryKeys.connections, (old) => (old ? { ...old, claude } : old));
  const [code, setCode] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const start = useMutation({
    mutationFn: () => api.claudeStart(),
    onSuccess: (login) => {
      window.open(login.url, "_blank", "noopener");
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });
  const complete = useMutation({
    mutationFn: ({ loginId, value }: { loginId: string; value: string }) => api.claudeComplete(loginId, value),
    onSuccess: (claude) => {
      setCode("");
      setClaude(claude);
    },
  });
  const cancel = useMutation({ mutationFn: (loginId: string) => api.claudeCancel(loginId), onSuccess: setClaude });
  const disconnect = useMutation({
    mutationFn: () => api.claudeDisconnect(),
    onSuccess: (claude) => {
      setConfirmDisconnect(false);
      setClaude(claude);
    },
  });

  const claude = connections.data?.claude;
  const error = [start, complete, cancel, disconnect].find((m) => m.isError)?.error ?? null;

  return (
    <Card component="section" aria-labelledby="claude-account-heading">
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2, p: 3 }}>
        <Typography id="claude-account-heading" variant="h2">
          Connect your Claude account
        </Typography>
        <Typography sx={{ color: "text.secondary" }}>Use your own Claude account for your missions instead of ViBread's key.</Typography>
        {connections.isPending ? (
          <Skeleton variant="rounded" height={48} />
        ) : connections.isError ? (
          <Alert severity="error">Couldn't load connections: {connections.error.message}</Alert>
        ) : !claude ? (
          <Alert severity="warning">This server doesn't report Claude account status yet.</Alert>
        ) : !claude.available ? (
          <Typography sx={{ color: "text.disabled" }}>This server can't connect Claude accounts (oh-my-pi isn't installed).</Typography>
        ) : (
          <>
            <Typography sx={{ fontWeight: 600 }}>{USING[claude.using]}</Typography>
            {claude.connected ? (
              <Stack direction="row" sx={{ gap: 1.5, alignItems: "center", flexWrap: "wrap" }}>
                <Chip
                  color="success"
                  icon={<CheckCircleIcon />}
                  label={`Connected as ${claude.email ?? "your Claude account"}${claude.orgName ? ` (${claude.orgName})` : ""}`}
                />
                {claude.connectedAt && (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    since {new Date(claude.connectedAt).toLocaleString()}
                  </Typography>
                )}
                <Button color="error" sx={{ ml: "auto" }} onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </Button>
              </Stack>
            ) : claude.pending ? (
              <Stack sx={{ gap: 1.5 }}>
                <Box>
                  <Button variant="contained" startIcon={<OpenInNewIcon />} href={claude.pending.url} target="_blank" rel="noopener">
                    Open Claude sign-in
                  </Button>
                </Box>
                <Box component="ol" sx={{ m: 0, pl: 3, "& li": { mb: 0.5 } }}>
                  <li>Sign in and approve.</li>
                  <li>
                    Claude will either show you a code, or send you to a page that can't load (localhost:54545…). Copy that code — or the
                    whole address from the address bar — and paste it here.
                  </li>
                </Box>
                <Stack
                  component="form"
                  direction="row"
                  sx={{ gap: 1, flexWrap: "wrap" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (claude.pending && code.trim()) complete.mutate({ loginId: claude.pending.loginId, value: code.trim() });
                  }}
                >
                  <TextField
                    label="Code or address from Claude"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    sx={{ flex: 1, minWidth: 260 }}
                    autoComplete="off"
                  />
                  <Button type="submit" variant="contained" disabled={!code.trim() || complete.isPending}>
                    {complete.isPending ? "Finishing…" : "Finish"}
                  </Button>
                  <Button onClick={() => claude.pending && cancel.mutate(claude.pending.loginId)} disabled={cancel.isPending}>
                    Cancel
                  </Button>
                </Stack>
                <Typography variant="body2" sx={{ color: "text.secondary" }} aria-live="polite">
                  {complete.isPending
                    ? "Checking with Claude… this can take up to a minute."
                    : "If you're on the same computer as ViBread, this may finish by itself after you approve."}
                </Typography>
              </Stack>
            ) : (
              <Box>
                <Button variant="contained" disabled={start.isPending} onClick={() => start.mutate()}>
                  {start.isPending ? "Starting…" : "Connect"}
                </Button>
              </Box>
            )}
          </>
        )}
        {error && <Alert severity="error">{friendly(error)}</Alert>}
      </CardContent>
      <Dialog open={confirmDisconnect} onClose={() => setConfirmDisconnect(false)}>
        <DialogTitle>Disconnect your Claude account?</DialogTitle>
        <DialogContent>
          <Typography>
            Your missions will go back to ViBread's own key (if this server has one). You can connect again any time.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDisconnect(false)}>Keep connected</Button>
          <Button color="error" variant="contained" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
