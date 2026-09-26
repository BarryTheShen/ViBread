import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "../api/auth.js";
import { HttpError } from "../api/client.js";
import { useMe } from "../api/hooks.js";
import { oauthClient, operatorLogin } from "./oauth.js";

/** OAuth sign-in step for apps like Claude Code connecting to ViBread (the server sends the browser here). */
export default function OAuthLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const client = useQuery({ queryKey: ["oauth-client", clientId], queryFn: ({ signal }) => oauthClient(clientId, signal), enabled: Boolean(clientId), retry: false });
  const me = useMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => operatorLogin(email.trim(), password),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });
  const appName = client.data?.name ?? "An app";
  const failure =
    login.error instanceof HttpError && login.error.code === "invalid_credentials"
      ? "That email and password don't match. Check them and try again."
      : login.error?.message;

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
          <Stack
            component="form"
            sx={{ gap: 2 }}
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {failure && <Alert severity="error">{failure}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={!email.trim() || !password || login.isPending || !clientId}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </Stack>
          {me.data?.auth === "google" && (
            <>
              <Divider>or</Divider>
              <Button
                variant="outlined"
                size="large"
                onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: window.location.href })}
              >
                Continue with Google
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
