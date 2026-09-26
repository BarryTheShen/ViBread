import { getJson, sendJson } from "../api/client.js";

/** Registered OAuth client as the server describes it (GET /api/oauth/client?client_id=). */
export interface OAuthClientInfo {
  clientId: string;
  name: string;
  uri?: string;
  redirectUris: string[];
  scopes: string[];
}

/** Plain-language meaning of each scope an app can ask for (PLAN §5.11). */
export const SCOPE_TEXT: Record<string, string> = {
  "circuits:read": "See your missions and designs",
  "circuits:write": "Change designs and run the design agent",
  "bench:request": "Ask for bench actions — you still click Start",
};

/** The raw query string of the current page, passed through to the server untouched (it is signed). */
export function rawOAuthQuery(): string {
  return window.location.search.slice(1);
}

export function oauthClient(clientId: string, signal?: AbortSignal): Promise<OAuthClientInfo> {
  return getJson<OAuthClientInfo>(`/api/oauth/client?client_id=${encodeURIComponent(clientId)}`, signal);
}

/** Social sign-in providers a multi-user server can offer. */
export type OAuthProvider = "google" | "github";

/** GET /api/oauth/providers: single-operator servers have no social sign-in; others list configured providers. */
export function oauthProviders(signal?: AbortSignal): Promise<{ singleOperator: boolean; providers: OAuthProvider[] }> {
  return getJson<{ singleOperator: boolean; providers: OAuthProvider[] }>("/api/oauth/providers", signal);
}

export function operatorLogin(email: string, password: string): Promise<{ redirect: string }> {
  return sendJson<{ redirect: string }>("POST", "/api/oauth/operator-login", { email, password, oauth_query: rawOAuthQuery() });
}

/** Better Auth consent endpoint; the answer names where to send the browser next. */
export async function submitConsent(accept: boolean): Promise<string> {
  const res = await sendJson<{ url?: string; redirect?: string; redirect_uri?: string; redirectURI?: string }>(
    "POST",
    "/api/auth/oauth2/consent",
    { accept, oauth_query: rawOAuthQuery() },
  );
  const next = res.url ?? res.redirect ?? res.redirect_uri ?? res.redirectURI;
  if (!next) throw new Error("The server accepted your answer but didn't say where to go next.");
  return next;
}
