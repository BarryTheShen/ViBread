import CloseIcon from "@mui/icons-material/Close";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import FormLabel from "@mui/material/FormLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import { useQuery } from "@tanstack/react-query";
import type { TokenMintResponse } from "@vibread/core";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { getJson } from "../api/client.js";
import { authClient } from "../api/auth.js";
import { ClaudeAccountSection } from "./ClaudeAccountSection.js";
import { useConnections, useImessageCode, useLanDevices, useMintToken, useMissions, useRevokeToken, useUnpairAllPhones } from "../api/hooks.js";
import { ErrorOrSignIn, ProviderButtons, useProviders } from "../components/SignIn.js";
import { agoLabel, expiryLabel, useNow } from "../lib/time.js";
import { MONO_FONT } from "../theme.js";

const SCOPES = [
  { id: "circuits:read", label: "Read your missions and designs" },
  { id: "circuits:write", label: "Propose design changes" },
  { id: "bench:request", label: "Ask for bench actions (a person still clicks Start at the bench)" },
] as const;

const TTLS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "24 hours" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outlined"
      startIcon={copied ? <CheckCircleIcon /> : <ContentCopyIcon />}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <Card component="section" aria-labelledby={id} sx={{ flexShrink: 0 }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2, p: 3 }}>
        <Typography id={id} variant="h2">
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

function MintedCommand({ minted }: { minted: TokenMintResponse }) {
  const [reveal, setReveal] = useState(false);
  const shown = reveal ? minted.command : minted.command.split(minted.token).join("••••••••");
  return (
    <Alert severity="success" icon={false}>
      <Typography sx={{ fontWeight: 600, mb: 1 }}>Paste this into your terminal to connect Claude Code:</Typography>
      <Box
        component="code"
        sx={{ display: "block", p: 1.5, bgcolor: "code.main", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 13, wordBreak: "break-all", mb: 1 }}
      >
        {shown}
      </Box>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <CopyButton text={minted.command} label="Copy command" />
        <Button startIcon={reveal ? <VisibilityOffIcon /> : <VisibilityIcon />} onClick={() => setReveal((v) => !v)}>
          {reveal ? "Hide token" : "Show token"}
        </Button>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Shown only once. {expiryLabel(minted.expiresAt, Date.now())}.
        </Typography>
      </Stack>
    </Alert>
  );
}

function ClaudeCodeSection() {
  const connections = useConnections();
  const mint = useMintToken();
  const revoke = useRevokeToken();
  const now = useNow(30_000);
  const [scopes, setScopes] = useState<string[]>(["circuits:read", "circuits:write"]);
  const [ttl, setTtl] = useState(480);
  const tokens = connections.data?.claudeCode.tokens ?? [];
  return (
    <Section title="Connect Claude Code" id="claude-heading">
      <Typography sx={{ color: "text.secondary" }}>
        Let Claude Code on your computer work on your ViBread missions over MCP. It gets a short-lived key that you can revoke
        any time. {connections.data && <>Server address: <code>{connections.data.mcpUrl}</code></>}
      </Typography>
      <FormControl component="fieldset">
        <FormLabel component="legend">What it may do</FormLabel>
        <FormGroup>
          {SCOPES.map((s) => (
            <FormControlLabel
              key={s.id}
              control={
                <Checkbox
                  checked={scopes.includes(s.id)}
                  onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))}
                />
              }
              label={s.label}
            />
          ))}
        </FormGroup>
      </FormControl>
      <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="ttl-label">Key lasts</InputLabel>
          <Select labelId="ttl-label" label="Key lasts" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            {TTLS.map((t) => (
              <MenuItem key={t.minutes} value={t.minutes}>
                {t.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button variant="contained" disabled={scopes.length === 0 || mint.isPending} onClick={() => mint.mutate({ scopes, ttlMinutes: ttl })}>
          {mint.isPending ? "Creating…" : "Create connection command"}
        </Button>
      </Stack>
      {mint.isError && <Alert severity="error">Couldn't create a key: {mint.error.message}</Alert>}
      {mint.data && <MintedCommand minted={mint.data} />}
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          Active keys
        </Typography>
        {connections.isPending ? (
          <Skeleton height={48} />
        ) : connections.isError ? (
          <ErrorOrSignIn error={connections.error}>
            <Alert severity="error">Couldn't load connections: {connections.error.message}</Alert>
          </ErrorOrSignIn>
        ) : tokens.length === 0 ? (
          <Typography sx={{ color: "text.secondary" }}>No keys yet. Claude Code is not connected.</Typography>
        ) : (
          <List dense disablePadding>
            {tokens.map((t) => (
              <ListItem
                key={t.id}
                divider
                secondaryAction={
                  <Button color="error" startIcon={<LinkOffIcon />} disabled={revoke.isPending} onClick={() => revoke.mutate(t.id, { onSuccess: () => mint.data?.id === t.id && mint.reset() })}>
                    Revoke
                  </Button>
                }
              >
                <ListItemText
                  primary={t.scopes.join(", ")}
                  secondary={`Created ${agoLabel(t.createdAt, now)} · ${expiryLabel(t.expiresAt, now)} · ${t.lastUsedAt ? `last used ${agoLabel(t.lastUsedAt, now)}` : "never used"}`}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Section>
  );
}

/** Phones paired over the LAN; only rendered on the laptop itself (the endpoint answers loopback requests only). */
function PhonesSection() {
  const devices = useLanDevices();
  const unpair = useUnpairAllPhones();
  const now = useNow(30_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (devices.isPending || devices.data === null) return null;
  if (devices.isError) {
    return (
      <Section title="Phones" id="phones-heading">
        <Alert severity="error">Couldn't load paired phones: {devices.error.message}</Alert>
      </Section>
    );
  }
  const list = devices.data;
  const lastUsed = list
    .map((d) => d.lastSeenAt ?? d.createdAt)
    .sort()
    .at(-1);
  return (
    <Section title="Phones" id="phones-heading">
      <Typography sx={{ color: "text.secondary" }}>
        Phones on your Wi-Fi open Build Mode by scanning the QR code in the Build steps view. A paired phone can continue build steps,
        scan parts, and send photo checks.
      </Typography>
      <Typography sx={{ fontWeight: 600 }}>
        {list.length === 0
          ? "No phones paired."
          : `${list.length} phone${list.length === 1 ? "" : "s"} paired${lastUsed ? ` · last used ${agoLabel(lastUsed, now)}` : ""}`}
      </Typography>
      {list.length > 0 && (
        <List dense disablePadding>
          {list.map((d) => (
            <ListItem key={d.id} disableGutters divider>
              <ListItemText
                primary={d.userAgent ? describeDevice(d.userAgent) : "Phone"}
                secondary={`Paired ${agoLabel(d.createdAt, now)}${d.lastSeenAt ? ` · last used ${agoLabel(d.lastSeenAt, now)}` : ""}`}
              />
            </ListItem>
          ))}
        </List>
      )}
      <Box>
        <Button color="error" variant="outlined" startIcon={<LinkOffIcon />} disabled={unpair.isPending} onClick={() => setConfirmOpen(true)}>
          Unpair all phones
        </Button>
      </Box>
      {unpair.isSuccess && <Alert severity="success">All phones unpaired. The QR code in the Steps tab is new; scan it again on each phone.</Alert>}
      {unpair.isError && <Alert severity="error">Couldn't unpair: {unpair.error.message}</Alert>}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Unpair all phones?</DialogTitle>
        <DialogContent>
          <Typography>Phones will need to scan the new QR code.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={unpair.isPending}
            onClick={() => unpair.mutate(undefined, { onSettled: () => setConfirmOpen(false) })}
          >
            {unpair.isPending ? "Unpairing…" : "Unpair all phones"}
          </Button>
        </DialogActions>
      </Dialog>
    </Section>
  );
}

/** "iPhone · Safari" style label from a user-agent string; falls back to a generic name. */
function describeDevice(userAgent: string): string {
  const device = /iPhone|iPad|Android|Pixel|Macintosh|Windows|Linux/.exec(userAgent)?.[0] ?? "Phone";
  const browser = /CriOS|Chrome|Firefox|FxiOS|Edg|Safari/.exec(userAgent)?.[0];
  const name = browser === "CriOS" ? "Chrome" : browser === "FxiOS" ? "Firefox" : browser === "Edg" ? "Edge" : browser;
  return name ? `${device} · ${name}` : device;
}

function ImessageSection() {
  const connections = useConnections();
  const code = useImessageCode();
  const now = useNow(10_000);
  const imessage = connections.data?.imessage;
  const number = code.data?.capcomNumber ?? imessage?.capcomNumber;
  return (
    <Section title="Link iMessage (CAPCOM)" id="imessage-heading">
      <Typography sx={{ color: "text.secondary" }}>
        Text your mission from your phone: get status, answer the agent's questions, and say "GO" ahead of a bench action. Anything
        physical still waits for a click at the bench.
      </Typography>
      {connections.data && !imessage?.capcomNumber && !imessage?.linked ? (
        // No CAPCOM number means the server has no iMessage provider: a link code would have nowhere to go.
        <Typography sx={{ color: "text.disabled" }}>iMessage isn't set up on this server.</Typography>
      ) : (
      <>
      {imessage?.linked ? (
        <Alert severity="success">Linked to {imessage.handle ?? "your phone"}.</Alert>
      ) : (
        <Typography>
          Not linked yet.{imessage?.capcomNumber && <> Your CAPCOM number is <strong>{imessage.capcomNumber}</strong>.</>}
        </Typography>
      )}
      <Box>
        <Button variant="contained" disabled={code.isPending} onClick={() => code.mutate()}>
          {code.isPending ? "Getting a code…" : imessage?.linked ? "Link a different phone" : "Get a link code"}
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
              {number ? (
                <>
                  to <strong>{number}</strong>
                </>
              ) : (
                "to your CAPCOM number"
              )}
              .
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
      )}
    </Section>
  );
}

/** Who is signed in. Mode comes from GET /api/oauth/providers (works before sign-in, unlike /api/me which is 401). */
function AccountSection() {
  const providers = useProviders();
  const session = authClient.useSession();
  const location = useLocation();
  if (providers.isPending || session.isPending) return <Skeleton variant="rounded" height={100} />;
  if (providers.isError) return <Alert severity="error">Couldn't reach the ViBread server: {providers.error.message}</Alert>;
  const user = session.data?.user;
  return (
    <Section title="Account" id="account-heading">
      {providers.data.singleOperator ? (
        <Typography>
          Single-operator mode: this server has no sign-in configured, so everyone who can open it acts as <strong>the operator</strong>.
        </Typography>
      ) : user ? (
        <Stack direction="row" sx={{ gap: 2, alignItems: "center" }}>
          <Typography sx={{ flex: 1 }}>
            Signed in as <strong>{user.name}</strong>
            {user.email ? ` (${user.email})` : ""}
          </Typography>
          <Button onClick={() => void authClient.signOut().then(() => window.location.assign("/"))}>Sign out</Button>
        </Stack>
      ) : (
        <>
          <Typography>Sign in to see your missions.</Typography>
          <ProviderButtons callbackURL={`${location.pathname}${location.search}`} />
        </>
      )}
    </Section>
  );
}

interface DiagnosticEntry {
  at: string;
  area: string;
  level: string;
  message: string;
}

function diagnosticEntries(value: unknown, fallbackArea: string): DiagnosticEntry[] {
  const records =
    Array.isArray(value) ? value : typeof value === "object" && value !== null
      ? ("entries" in value && Array.isArray(value.entries) ? value.entries : "lines" in value && Array.isArray(value.lines) ? value.lines : "logs" in value && Array.isArray(value.logs) ? value.logs : [])
      : [];
  return records.map((record) => {
    let parsed: unknown = record;
    if (typeof record === "string") {
      try {
        parsed = JSON.parse(record);
      } catch {
        return { at: "", area: fallbackArea, level: "info", message: record };
      }
    }
    if (typeof parsed !== "object" || parsed === null) return { at: "", area: fallbackArea, level: "info", message: String(parsed) };
    const item = parsed as Record<string, unknown>;
    const message = typeof item.message === "string" ? item.message : typeof item.msg === "string" ? item.msg : typeof item.text === "string" ? item.text : JSON.stringify(parsed);
    const at = typeof item.at === "string" ? item.at : typeof item.timestamp === "string" ? item.timestamp : typeof item.time === "string" ? item.time : typeof item.ts === "string" ? item.ts : "";
    const area = typeof item.area === "string" ? item.area : typeof item.scope === "string" ? item.scope : fallbackArea;
    const level = typeof item.level === "string" ? item.level : typeof item.severity === "string" ? item.severity : "info";
    return { at, area, level, message };
  });
}

function diagnosticLine(entry: DiagnosticEntry): string {
  const at = entry.at ? `[${entry.at}] ` : "";
  return `${at}${entry.area} ${entry.level}: ${entry.message}`;
}

function DiagnosticsSection() {
  const missions = useMissions();
  const [missionId, setMissionId] = useState("");
  const [area, setArea] = useState("all");
  const [level, setLevel] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const serverLog = useQuery({
    queryKey: ["debug", "server-log"],
    queryFn: ({ signal }) => getJson<unknown>("/api/debug/server-log?tail=300", signal),
    refetchInterval: autoRefresh ? 3_000 : false,
    retry: false,
  });
  const missionLog = useQuery({
    queryKey: ["debug", "mission-log", missionId],
    queryFn: ({ signal }) => getJson<unknown>(`/api/debug/missions/${encodeURIComponent(missionId)}/log?tail=300`, signal),
    enabled: missionId.length > 0,
    refetchInterval: autoRefresh ? 3_000 : false,
    retry: false,
  });
  const entries = [
    ...diagnosticEntries(serverLog.data, "server"),
    ...diagnosticEntries(missionLog.data, `mission:${missionId}`),
  ];
  const areas = [...new Set(entries.map((entry) => entry.area))].sort();
  const levels = [...new Set(entries.map((entry) => entry.level))].sort();
  const filtered = entries.filter((entry) => (area === "all" || entry.area === area) && (level === "all" || entry.level === level));
  const copyReport = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    const report = filtered.map(diagnosticLine).join("\n");
    void clipboard.writeText(report).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    });
  };
  return (
    <Section title="Diagnostics" id="diagnostics-heading">
      <Typography color="text.secondary">
        Recent laptop and mission logs help diagnose a failed build. Logs stay on this machine until you copy them.
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} sx={{ gap: 1.5, alignItems: { sm: "center" }, flexWrap: "wrap" }}>
        <FormControl size="small" sx={{ minWidth: 190 }}>
          <InputLabel id="diagnostics-mission-label">Mission log (optional)</InputLabel>
          <Select labelId="diagnostics-mission-label" label="Mission log (optional)" value={missionId} onChange={(event) => setMissionId(event.target.value)}>
            <MenuItem value="">No mission</MenuItem>
            {(missions.data ?? []).map((mission) => <MenuItem key={mission.id} value={mission.id}>{mission.title}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel id="diagnostics-area-label">Area</InputLabel>
          <Select labelId="diagnostics-area-label" label="Area" value={area} onChange={(event) => setArea(event.target.value)}>
            <MenuItem value="all">All areas</MenuItem>
            {areas.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel id="diagnostics-level-label">Level</InputLabel>
          <Select labelId="diagnostics-level-label" label="Level" value={level} onChange={(event) => setLevel(event.target.value)}>
            <MenuItem value="all">All levels</MenuItem>
            {levels.map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControlLabel control={<Checkbox checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />} label="Auto-refresh" />
        <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={copyReport} disabled={filtered.length === 0}>
          {copied ? "Copied" : "Copy for bug report"}
        </Button>
      </Stack>
      {(serverLog.isError || missionLog.isError) && (
        <Alert severity="info">
          Diagnostic logs are unavailable from this browser unless ViBread is running on the laptop.
        </Alert>
      )}
      <Box component="pre" sx={{ m: 0, p: 1.5, maxHeight: 300, overflow: "auto", bgcolor: "code.main", color: "text.primary", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {filtered.length > 0 ? filtered.map(diagnosticLine).join("\n") : "No diagnostic entries match these filters."}
      </Box>
    </Section>
  );
}

function GeneralSection() {
  const { mode, setMode } = useColorScheme();
  return (
    <Section title="General" id="general-heading">
      <FormControl fullWidth size="small">
        <InputLabel id="theme-mode-label">Theme</InputLabel>
        <Select
          labelId="theme-mode-label"
          label="Theme"
          value={mode ?? "system"}
          onChange={(event) => setMode(event.target.value as "system" | "light" | "dark")}
        >
          <MenuItem value="system">System (follow computer)</MenuItem>
          <MenuItem value="light">Light</MenuItem>
          <MenuItem value="dark">Dark</MenuItem>
        </Select>
      </FormControl>
    </Section>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const providers = useProviders();
  const session = authClient.useSession();
  const signedOut = providers.data !== undefined && !providers.data.singleOperator && !session.isPending && !session.data?.user;
  const canGoBackInApp = typeof window.history.state?.idx === "number" && window.history.state.idx > 0;
  const close = () => (canGoBackInApp ? navigate(-1) : navigate("/"));
  return (
    <Dialog open onClose={close} fullWidth maxWidth="md" scroll="paper" aria-labelledby="settings-title">
      <DialogTitle id="settings-title" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography component="span" variant="h2" sx={{ flex: 1 }}>Settings</Typography>
        <Tooltip title="Close settings">
          <IconButton aria-label="Close settings" onClick={close}><CloseIcon /></IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent dividers sx={{ display: "flex", flexDirection: "column", gap: 2.5, bgcolor: "background.default" }}>
        <AccountSection />
        <GeneralSection />
        {/* Signed out on a multi-user server: the account card's sign-in is the only thing that can work. */}
        {!signedOut && (
          <>
            <Section title="Claude" id="claude-heading">
              <ClaudeAccountSection />
            </Section>
            <ClaudeCodeSection />
            <ImessageSection />
            <PhonesSection />
          </>
        )}
        <DiagnosticsSection />
        <Section title="About" id="about-heading">
          <Typography>ViBread helps you prototype Arduino circuits with an AI-assisted design and build workflow.</Typography>
          <Typography color="text.secondary">Not affiliated with Anthropic.</Typography>
        </Section>
      </DialogContent>
    </Dialog>
  );
}
