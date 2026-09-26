import CheckIcon from "@mui/icons-material/Check";
import GppMaybeIcon from "@mui/icons-material/GppMaybe";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { HttpError } from "../api/client.js";
import { MONO_FONT } from "../theme.js";
import { oauthClient, SCOPE_TEXT, submitConsent } from "./oauth.js";

function hostOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** OAuth consent: what the connecting app may do, in plain words, with Allow / Deny. */
export default function OAuthConsentPage() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const client = useQuery({ queryKey: ["oauth-client", clientId], queryFn: ({ signal }) => oauthClient(clientId, signal), enabled: Boolean(clientId), retry: false });
  const answer = useMutation({ mutationFn: (accept: boolean) => submitConsent(accept), onSuccess: (next) => window.location.assign(next) });
  const requested = (params.get("scope") ?? "").split(/[\s+]+/).filter(Boolean);
  const scopes = (requested.length ? requested : client.data?.scopes ?? []).filter((s) => s !== "openid" && s !== "offline_access");
  const redirectHost = hostOf(params.get("redirect_uri")) ?? hostOf(client.data?.redirectUris[0]);
  const name = client.data?.name ?? "This app";

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2 }}>
      <Card sx={{ width: "100%", maxWidth: 480 }}>
        <CardContent sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
            <GppMaybeIcon color="secondary" />
            <Typography variant="overline" sx={{ color: "secondary.main" }}>
              Permission needed
            </Typography>
          </Stack>
          {client.isPending && clientId ? (
            <Skeleton variant="rounded" height={120} />
          ) : !clientId || client.isError ? (
            <Alert severity="error">
              {client.error instanceof HttpError && client.error.status === 404
                ? "ViBread doesn't know the app that sent you here. Start the connection again from the app."
                : "This permission link is incomplete or out of date. Start the connection again from the app."}
            </Alert>
          ) : (
            <>
              <Typography variant="h2" component="h1">
                Allow {name} to use ViBread?
              </Typography>
              <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
                {redirectHost && <Chip variant="outlined" label={`Sends you back to ${redirectHost}`} sx={{ fontFamily: MONO_FONT }} />}
                {client.data?.uri && <Chip variant="outlined" label={hostOf(client.data.uri) ?? client.data.uri} />}
              </Stack>
              <Box>
                <Typography sx={{ fontWeight: 600 }}>It will be able to:</Typography>
                <List dense disablePadding>
                  {scopes.map((s) => (
                    <ListItem key={s} disableGutters>
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        <CheckIcon color="success" fontSize="small" />
                      </ListItemIcon>
                      <ListItemText primary={SCOPE_TEXT[s] ?? s} secondary={SCOPE_TEXT[s] ? s : undefined} slotProps={{ secondary: { sx: { fontFamily: MONO_FONT, fontSize: 11 } } }} />
                    </ListItem>
                  ))}
                </List>
              </Box>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                It can never flash or test your board on its own: physical actions always wait for you to click Start at the bench. You can
                disconnect it any time in Settings.
              </Typography>
              {answer.isError && <Alert severity="error">That didn't go through: {answer.error.message}</Alert>}
              <Stack direction="row" sx={{ gap: 1, justifyContent: "flex-end" }}>
                <Button variant="outlined" color="error" disabled={answer.isPending} onClick={() => answer.mutate(false)}>
                  Deny
                </Button>
                <Button variant="contained" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
                  {answer.isPending && answer.variables ? "Allowing…" : "Allow"}
                </Button>
              </Stack>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
