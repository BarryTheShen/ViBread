import LoginIcon from "@mui/icons-material/Login";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { authClient } from "../api/auth.js";
import { HttpError } from "../api/client.js";
import { oauthProviders, type OAuthProvider } from "../pages/oauth.js";
import { DEMO } from "../demo/demo.js";

export const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", github: "GitHub" };

/** GET /api/oauth/providers, shared by /login, Settings and the signed-out banner. */
export function useProviders() {
  return useQuery({ queryKey: ["oauth-providers"], queryFn: ({ signal }) => oauthProviders(signal), retry: false, staleTime: 60_000 });
}

/** A 401 from the ViBread API: the person isn't signed in (multi-user servers only). */
export function isSignInRequired(error: unknown): boolean {
  // The read-only demo has no accounts: never offer a sign-in.
  return !DEMO && error instanceof HttpError && error.status === 401;
}

/** Link to the plain /login page that comes back to the current page after signing in. */
export function useSignInHref(): string {
  const location = useLocation();
  return `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

/** The short signed-out state every page shows instead of a raw 401. */
export function SignInRequired({ message = "Sign in to see your missions." }: { message?: string }) {
  const href = useSignInHref();
  return (
    <Alert
      severity="info"
      action={
        <Button component={RouterLink} to={href} startIcon={<LoginIcon />} sx={{ whiteSpace: "nowrap" }}>
          Sign in
        </Button>
      }
    >
      {message}
    </Alert>
  );
}

/** Renders a query error: the sign-in prompt for a 401, the given fallback otherwise. */
export function ErrorOrSignIn({ error, children, message }: { error: unknown; children: ReactNode; message?: string }) {
  return isSignInRequired(error) ? <SignInRequired message={message} /> : <>{children}</>;
}

/** Only callback targets on this site: relative paths, never `//host` or absolute URLs (no open redirect). */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * One button per configured provider (Google / GitHub). Better Auth signs in and returns the browser to `callbackURL`.
 * Renders nothing on single-operator servers (there is no sign-in there).
 */
export function ProviderButtons({ callbackURL, disabled = false }: { callbackURL: string; disabled?: boolean }) {
  const providers = useProviders();
  const social = useMutation({
    mutationFn: async (provider: OAuthProvider) => {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (result.error) throw new Error(result.error.message ?? `Couldn't start ${PROVIDER_LABEL[provider]} sign-in.`);
    },
  });
  if (providers.isPending) return <Skeleton variant="rounded" height={48} />;
  if (providers.isError) return <Alert severity="error">Couldn't reach ViBread's sign-in service: {providers.error.message}</Alert>;
  if (providers.data.singleOperator) return null;
  if (providers.data.providers.length === 0) {
    return <Alert severity="error">This ViBread has no sign-in method set up. Ask whoever runs it to add Google or GitHub.</Alert>;
  }
  return (
    <Stack sx={{ gap: 1.5 }}>
      {providers.data.providers.map((provider) => (
        <Button key={provider} variant="contained" size="large" disabled={disabled || social.isPending} onClick={() => social.mutate(provider)}>
          {social.isPending && social.variables === provider ? "Opening…" : `Continue with ${PROVIDER_LABEL[provider]}`}
        </Button>
      ))}
      {social.isError && <Alert severity="error">{social.error.message}</Alert>}
    </Stack>
  );
}
