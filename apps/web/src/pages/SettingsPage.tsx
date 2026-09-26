import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
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
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TokenMintResponse } from "@vibread/core";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { authClient } from "../api/auth.js";
import { useConnections, useImessageCode, useMe, useMintToken, useRevokeToken } from "../api/hooks.js";
import { useDefaultMode } from "../lib/prefs.js";
import { agoLabel, expiryLabel, useNow } from "../lib/time.js";
import { MONO_FONT } from "../theme.js";
import { MODE_HELP, ModeSelect, PHYSICAL_NOTE } from "../workspace/ModeSelect.js";

const SCOPES = [
  { id: "circuits:read", label: "Read your missions and designs" },
  { id: "circuits:write", label: "Propose design changes (your permission mode still applies)" },
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
    <Card component="section" aria-labelledby={id}>
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
        sx={{ display: "block", p: 1.5, bgcolor: "#060a0e", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 13, wordBreak: "break-all", mb: 1 }}
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
          <Alert severity="error">Couldn't load connections: {connections.error.message}</Alert>
        ) : tokens.length === 0 ? (
          <Typography sx={{ color: "text.secondary" }}>No keys yet. Claude Code is not connected.</Typography>
        ) : (
          <List dense disablePadding>
            {tokens.map((t) => (
              <ListItem
                key={t.id}
                divider
                secondaryAction={
                  <Button color="error" startIcon={<LinkOffIcon />} disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
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
      {imessage?.linked ? (
        <Alert severity="success">Linked to {imessage.handle ?? "your phone"}.</Alert>
      ) : (
        <Typography>Not linked yet.</Typography>
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
            <Box sx={{ bgcolor: "#fff", p: 1, borderRadius: 1, lineHeight: 0 }}>
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
    </Section>
  );
}

function AccountSection() {
  const me = useMe();
  if (me.isPending) return <Skeleton variant="rounded" height={100} />;
  if (me.isError) return <Alert severity="error">Couldn't reach the ViBread server: {me.error.message}</Alert>;
  return (
    <Section title="Account" id="account-heading">
      {me.data.auth === "single-operator" ? (
        <Typography>
          Single-operator mode: this server has no sign-in configured, so everyone who can open it acts as{" "}
          <strong>{me.data.user?.name ?? "the operator"}</strong>.
        </Typography>
      ) : me.data.user ? (
        <Stack direction="row" sx={{ gap: 2, alignItems: "center" }}>
          <Typography sx={{ flex: 1 }}>
            Signed in as <strong>{me.data.user.name}</strong>
            {me.data.user.email ? ` (${me.data.user.email})` : ""}
          </Typography>
          <Button onClick={() => void authClient.signOut().then(() => me.refetch())}>Sign out</Button>
        </Stack>
      ) : (
        <Box>
          <Button variant="contained" onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: window.location.href })}>
            Sign in with Google
          </Button>
        </Box>
      )}
    </Section>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [defaultMode, setDefaultMode] = useDefaultMode();
  return (
    <Box sx={{ minHeight: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1 }}>
          <Tooltip title="Back">
            <IconButton aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Typography variant="h3" component="h1" sx={{ flex: 1 }}>
            Settings &amp; connections
          </Typography>
          <Button component={RouterLink} to="/">
            All missions
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="md" sx={{ py: 4, display: "flex", flexDirection: "column", gap: 3 }}>
        <AccountSection />
        <ClaudeCodeSection />
        <ImessageSection />
        <Section title="Default permission mode" id="mode-heading">
          <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap" }}>
            <ModeSelect id="default-mode" value={defaultMode} onChange={setDefaultMode} label="New missions start in" size="medium" />
            <Chip variant="outlined" label="Saved in this browser" />
          </Stack>
          <Typography sx={{ color: "text.secondary" }}>
            {MODE_HELP[defaultMode]} {PHYSICAL_NOTE}
          </Typography>
        </Section>
      </Container>
    </Box>
  );
}
