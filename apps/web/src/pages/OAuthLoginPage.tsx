import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link as RouterLink } from "react-router";
import { authClient } from "../api/auth.js";
import { HttpError } from "../api/client.js";
import { ProviderButtons, safeNext, useProviders } from "../components/SignIn.js";
import { oauthClient, operatorLogin, rawOAuthQuery } from "./oauth.js";

/** Single-operator servers have one built-in account; the server bootstraps its credential (Channels' contract). */
const OPERATOR_EMAIL = "operator@vibread.local";

const LOGIN_ERRORS: Record<string, string> = {
  link_expired: "This sign-in link expired. Start the connection again from the app.",
  invalid_credentials: "ViBread couldn't sign you in. Start the connection again from the app.",
};

/**
 * `/login` serves two flows:
 * - OAuth (the server sends the browser here with a signed `client_id=…` query, e.g. Claude Code connecting):
 *   single-operator → "Continue as Operator"; multi-user → provider buttons whose `callbackURL` is this same
 *   `/login?<signed query>`, and once signed in the page resumes at `/consent?<same query>`.
 * - Plain sign-in (`/login?next=/m/…`, linked from any page that got a 401): provider buttons, then back to `next`.
 */
export default function OAuthLoginPage() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const oauthFlow = Boolean(clientId);
  const next = safeNext(params.get("next"));
  const client = useQuery({ queryKey: ["oauth-client", clientId], queryFn: ({ signal }) => oauthClient(clientId, signal), enabled: oauthFlow, retry: false });
  const providers = useProviders();
  const multiUser = providers.data !== undefined && !providers.data.singleOperator;
  const session = authClient.useSession();
  const signedIn = multiUser && Boolean(session.data?.user);

  useEffect(() => {
    if (!signedIn) return;
    window.location.replace(oauthFlow ? `/consent?${rawOAuthQuery()}` : next);
  }, [signedIn, oauthFlow, next]);

  const login = useMutation({
    mutationFn: () => operatorLogin(OPERATOR_EMAIL, ""),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });
  const failure = login.error instanceof HttpError && LOGIN_ERRORS[login.error.code] ? LOGIN_ERRORS[login.error.code] : login.error?.message;
  const blocked = oauthFlow && client.isError;

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
            {oauthFlow ? `Sign in to connect ${client.data ? client.data.name : "an app"}` : "Sign in to ViBread"}
          </Typography>
          {oauthFlow ? (
            client.isError ? (
              <Alert severity="error">
                {client.error instanceof HttpError && client.error.status === 404
                  ? "ViBread doesn't know the app that sent you here. Start the connection again from the app."
                  : `Couldn't check the app: ${client.error.message}`}
              </Alert>
            ) : (
              <Typography sx={{ color: "text.secondary" }}>
                {client.data?.name ?? "An app"} wants to work with your ViBread missions. Sign in first; next you'll see exactly what it can do.
              </Typography>
            )
          ) : (
            <Typography sx={{ color: "text.secondary" }}>Sign in to see your missions. You'll come straight back to where you were.</Typography>
          )}
          {providers.isPending || (multiUser && session.isPending) ? (
            <Skeleton variant="rounded" height={48} />
          ) : signedIn ? (
            <Stack direction="row" sx={{ gap: 1.5, alignItems: "center" }}>
              <CircularProgress size={20} aria-hidden />
              <Typography>Signed in as {session.data?.user.name ?? session.data?.user.email}. Continuing…</Typography>
            </Stack>
          ) : multiUser ? (
            <ProviderButtons callbackURL={oauthFlow ? `/login?${rawOAuthQuery()}` : next} disabled={blocked} />
          ) : providers.isError ? (
            <Alert severity="error">Couldn't reach ViBread's sign-in service: {providers.error.message}</Alert>
          ) : oauthFlow ? (
            <>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                This ViBread runs for one person on this computer, so there's no password: continue as the operator.
              </Typography>
              <Button variant="contained" size="large" disabled={blocked || login.isPending} onClick={() => login.mutate()}>
                {login.isPending ? "Signing in…" : "Continue as Operator"}
              </Button>
            </>
          ) : (
            <>
              <Typography>This ViBread runs for one person on this computer, so there's nothing to sign in to.</Typography>
              <Button component={RouterLink} to={next} variant="contained" size="large">
                Continue
              </Button>
            </>
          )}
          {failure && <Alert severity="error">{failure}</Alert>}
        </CardContent>
      </Card>
    </Box>
  );
}
