import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { authClient } from "../api/auth.js";
import { HttpError } from "../api/client.js";
import { useMe } from "../api/hooks.js";
import { oauthClient, operatorLogin } from "./oauth.js";

/** Single-operator servers have one built-in account; the server bootstraps its credential (Channels' contract). */
const OPERATOR_EMAIL = "operator@vibread.local";

const LOGIN_ERRORS: Record<string, string> = {
  link_expired: "This sign-in link expired. Start the connection again from the app.",
  invalid_credentials: "ViBread couldn't sign you in. Start the connection again from the app.",
};

/** OAuth sign-in step for apps like Claude Code connecting to ViBread (the server sends the browser here). */
export default function OAuthLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const client = useQuery({ queryKey: ["oauth-client", clientId], queryFn: ({ signal }) => oauthClient(clientId, signal), enabled: Boolean(clientId), retry: false });
  const me = useMe();
  const login = useMutation({
    mutationFn: () => operatorLogin(OPERATOR_EMAIL, ""),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });
  const appName = client.data?.name ?? "An app";
  const failure = login.error instanceof HttpError && LOGIN_ERRORS[login.error.code] ? LOGIN_ERRORS[login.error.code] : login.error?.message;

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2 }}>
      <Card sx={{ width: "100%", maxWidth: 440 }}>
        <CardContent sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
            <RocketLaunchIcon color="primary" />
            <Typography variant="overline" sx={{ color: "text.secondary" }}>
              ViBread · Mission Control
            </Typography>
          </Stack>
          <Typography variant="h2" component="h1">
            Sign in to connect {client.data ? client.data.name : "an app"}
          </Typography>
          {!clientId ? (
            <Alert severity="error">This sign-in link is incomplete. Start the connection again from the app.</Alert>
          ) : client.isError ? (
            <Alert severity="error">
              {client.error instanceof HttpError && client.error.status === 404
                ? "ViBread doesn't know the app that sent you here. Start the connection again from the app."
                : `Couldn't check the app: ${client.error.message}`}
            </Alert>
          ) : (
            <Typography sx={{ color: "text.secondary" }}>
              {appName} wants to work with your ViBread missions. Sign in first; next you'll see exactly what it can do.
            </Typography>
          )}
          {me.isPending ? (
            <Skeleton variant="rounded" height={48} />
          ) : me.data?.auth === "google" ? (
            <Button
              variant="contained"
              size="large"
              onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: window.location.href })}
            >
              Continue with Google
            </Button>
          ) : (
            <>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                This ViBread runs for one person on this computer, so there's no password: continue as the operator.
              </Typography>
              <Button variant="contained" size="large" disabled={!clientId || client.isError || login.isPending} onClick={() => login.mutate()}>
                {login.isPending ? "Signing in…" : `Continue as ${me.data?.user?.name ?? "Operator"}`}
              </Button>
            </>
          )}
          {failure && <Alert severity="error">{failure}</Alert>}
        </CardContent>
      </Card>
    </Box>
  );
}
