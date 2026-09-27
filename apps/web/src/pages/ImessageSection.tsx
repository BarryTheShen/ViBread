import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { getJson, sendJson } from "../api/client.js";
import { useImessageCode } from "../api/hooks.js";
import { ErrorOrSignIn } from "../components/SignIn.js";
import { expiryLabel, useNow } from "../lib/time.js";
import { MONO_FONT } from "../theme.js";

/** GET/PATCH /api/connections/imessage/settings (apps/server/src/routes.ts; not in packages/core yet). */
interface ImessageSettings {
  provider: "off" | "terminal" | "cloud";
  running: boolean;
  error?: string;
  /** What the server still needs, by environment variable name. */
  missing: string[];
  number?: string;
  photon: { projectId?: string; secretSaved: boolean; number?: string; source: "settings" | "env" | "none" };
  linked: boolean;
  handle?: string;
  prefs: {
    questions: boolean;
    designs: boolean;
    bench: boolean;
    quietHours: { enabled: boolean; start: string; end: string; timeZone: string };
  };
  /** Photon credentials can be saved only on the ViBread computer itself. */
  canEditPhoton: boolean;
}

type PrefsPatch = Partial<Omit<ImessageSettings["prefs"], "quietHours">> & { quietHours?: Partial<ImessageSettings["prefs"]["quietHours"]> };

const SETTINGS_KEY = ["imessage-settings"] as const;
const PATH = "/api/connections/imessage";
const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const CATEGORIES: { key: "questions" | "designs" | "bench"; label: string; hint: string }[] = [
  { key: "questions", label: "Questions from Claude", hint: "The question and its choices as a poll; answer from your phone." },
  { key: "designs", label: "When designs are ready / checks fail", hint: "Ready for GO, NO-GO, a ViBread limit, a failed or long run." },
  { key: "bench", label: "Bench results", hint: "Self-test results, fault alerts, bench prompts, launch." },
];

function PhotonForm({ settings, onSaved }: { settings: ImessageSettings; onSaved(next: ImessageSettings): void }) {
  const [projectId, setProjectId] = useState(settings.photon.source === "settings" ? (settings.photon.projectId ?? "") : "");
  const [projectSecret, setProjectSecret] = useState("");
  const [number, setNumber] = useState(settings.photon.source === "settings" ? (settings.photon.number ?? "") : "");
  const save = useMutation({
    mutationFn: () => sendJson<ImessageSettings>("PATCH", `${PATH}/photon`, { projectId, number, ...(projectSecret ? { projectSecret } : {}) }),
    onSuccess: (next) => {
      setProjectSecret("");
      onSaved(next);
    },
  });
  return (
    <Stack component="form" sx={{ gap: 1.5, maxWidth: 480 }} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <Typography variant="subtitle2">Photon project (the iMessage provider)</Typography>
      <TextField size="small" label="Project ID" value={projectId} onChange={(event) => setProjectId(event.target.value)} autoComplete="off" />
      <TextField
        size="small"
        label="Project secret"
        type="password"
        value={projectSecret}
        onChange={(event) => setProjectSecret(event.target.value)}
        helperText={settings.photon.secretSaved ? "A secret is saved: leave this empty to keep it. It stays on this computer." : "Stays on this computer; ViBread never shows it again."}
        autoComplete="new-password"
      />
      <TextField size="small" label="CAPCOM phone number" value={number} onChange={(event) => setNumber(event.target.value)} placeholder="+1 555 555 0123" autoComplete="off" />
      <Box>
        <Button type="submit" variant="outlined" disabled={save.isPending || !projectId.trim() || (!projectSecret && !settings.photon.secretSaved)}>
          {save.isPending ? "Starting CAPCOM…" : "Save and start CAPCOM"}
        </Button>
      </Box>
      {save.isError && <Alert severity="error">{save.error.message}</Alert>}
    </Stack>
  );
}

function LinkCode({ number, provider }: { number?: string; provider: ImessageSettings["provider"] }) {
  const code = useImessageCode();
  const now = useNow(10_000);
  const target = provider === "terminal" ? "in the server's terminal chat" : number ? <>to <strong>{number}</strong></> : "to your CAPCOM number";
  return (
    <>
      <Box>
        <Button variant="contained" disabled={code.isPending} onClick={() => code.mutate()}>
          {code.isPending ? "Getting a code…" : "Get a link code"}
        </Button>
      </Box>
      {code.isError && <Alert severity="error">Couldn't create a code: {code.error.message}</Alert>}
      {code.data && (
        <Stack direction="row" sx={{ gap: 3, alignItems: "center", flexWrap: "wrap" }}>
          {code.data.link && (
            <Box sx={{ bgcolor: "qr.main", p: 1, borderRadius: 1, lineHeight: 0 }}>
              <QRCodeSVG value={code.data.link} size={140} title="Scan to text the link code" />
            </Box>
          )}
          <Box>
            <Typography>
              Text{" "}
              <Box component="span" sx={{ fontFamily: MONO_FONT, fontWeight: 700, fontSize: "1.2rem", letterSpacing: "0.1em" }}>
                {code.data.code}
              </Box>{" "}
              {target}.
            </Typography>
            {code.data.link && (
              <Link href={code.data.link} sx={{ display: "inline-block", mt: 0.5 }}>
                Open in Messages
              </Link>
            )}
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
              {expiryLabel(code.data.expiresAt, now)} · works once
            </Typography>
          </Box>
        </Stack>
      )}
    </>
  );
}

/** Settings → iMessage (CAPCOM): link status, test message, what CAPCOM texts you about, quiet hours, Photon setup. */
export function ImessageSection() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => getJson<ImessageSettings>(`${PATH}/settings`, signal),
    // While not linked, pick up a redeemed link code without a reload.
    refetchInterval: (query) => (query.state.data && query.state.data.running && !query.state.data.linked ? 5_000 : false),
  });
  const setSettings = (next: ImessageSettings) => qc.setQueryData(SETTINGS_KEY, next);
  const savePrefs = useMutation({
    mutationFn: (patch: PrefsPatch) => sendJson<ImessageSettings>("PATCH", `${PATH}/settings`, patch),
    onMutate: (patch) => {
      const old = qc.getQueryData<ImessageSettings>(SETTINGS_KEY);
      if (old) setSettings({ ...old, prefs: { ...old.prefs, ...patch, quietHours: { ...old.prefs.quietHours, ...patch.quietHours } } });
      return { old };
    },
    onError: (_error, _patch, context) => context?.old && setSettings(context.old),
    onSuccess: setSettings,
  });
  const test = useMutation({ mutationFn: () => sendJson<{ ok: true }>("POST", `${PATH}/test`) });

  if (settings.isPending) return <Skeleton variant="rounded" height={160} />;
  if (settings.isError) {
    return (
      <ErrorOrSignIn error={settings.error}>
        <Alert severity="error">Couldn't load the iMessage settings: {settings.error.message}</Alert>
      </ErrorOrSignIn>
    );
  }
  const s = settings.data;
  const quiet = s.prefs.quietHours;
  const setQuiet = (patch: Partial<typeof quiet>) => savePrefs.mutate({ quietHours: { ...patch, timeZone: browserTimeZone() } });

  return (
    <>
      <Typography sx={{ color: "text.secondary" }}>
        Claude texts you its questions and tells you when a design is ready or a check fails, for every mission. Reply to answer,
        say "GO" to start building, or ask for "status". Anything physical still waits for a click at the bench.
      </Typography>

      {s.provider === "off" && (
        <Alert severity="info">
          iMessage isn't set up on this server. To turn it on, set{" "}
          {s.missing.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <Box component="code" sx={{ fontFamily: MONO_FONT }}>{name}</Box>
            </span>
          ))}{" "}
          and restart ViBread{s.canEditPhoton ? ", or enter your Photon project below" : ""}.
        </Alert>
      )}
      {s.provider === "cloud" && !s.running && (
        <Alert severity="error">
          CAPCOM isn't running{s.error ? `: ${s.error}` : "."}
          {s.missing.length > 0 && <> Missing: {s.missing.join(", ")}.</>}
        </Alert>
      )}
      {s.provider === "terminal" && <Alert severity="info">CAPCOM is in terminal test mode: its messages appear in the server's terminal, not on a phone.</Alert>}

      {s.running && (
        <>
          {s.linked ? (
            <Alert severity="success">Linked to {s.handle ?? "your phone"}.</Alert>
          ) : (
            <Typography>
              Not linked yet.{s.number && <> Your CAPCOM number is <strong>{s.number}</strong>.</>}
            </Typography>
          )}
          {!s.linked && <LinkCode {...(s.number ? { number: s.number } : {})} provider={s.provider} />}
          {s.linked && (
            <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap" }}>
              <Button variant="outlined" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Sending…" : "Send a test message"}
              </Button>
              {test.isSuccess && <Typography sx={{ color: "success.main" }}>Sent — check your phone.</Typography>}
            </Stack>
          )}
          {test.isError && <Alert severity="error">{test.error.message}</Alert>}
        </>
      )}

      <Divider />
      <FormGroup>
        {CATEGORIES.map((category) => (
          <FormControlLabel
            key={category.key}
            control={<Switch checked={s.prefs[category.key]} onChange={(event) => savePrefs.mutate({ [category.key]: event.target.checked })} />}
            label={
              <Box>
                <Typography>{category.label}</Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>{category.hint}</Typography>
              </Box>
            }
            sx={{ alignItems: "flex-start", my: 0.5, "& .MuiSwitch-root": { mt: -0.5 } }}
          />
        ))}
      </FormGroup>

      <Box>
        <FormControlLabel
          control={<Switch checked={quiet.enabled} onChange={(event) => setQuiet({ enabled: event.target.checked })} />}
          label="Quiet hours"
        />
        <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap", mt: 1 }}>
          <TextField size="small" type="time" label="From" value={quiet.start} disabled={!quiet.enabled} onChange={(event) => event.target.value && setQuiet({ start: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField size="small" type="time" label="Until" value={quiet.end} disabled={!quiet.enabled} onChange={(event) => event.target.value && setQuiet({ end: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {quiet.enabled ? `Your time (${quiet.timeZone})` : "Off"}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          Notifications are held, not dropped, and arrive as one message when quiet hours end. Replies to your texts always go
          through.
        </Typography>
      </Box>
      {savePrefs.isError && <Alert severity="error">Couldn't save: {savePrefs.error.message}</Alert>}

      {s.canEditPhoton && s.provider !== "terminal" && (
        <>
          <Divider />
          <PhotonForm settings={s} onSaved={setSettings} />
        </>
      )}
    </>
  );
}
