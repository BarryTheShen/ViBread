import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for /api/auth/*. In single-operator mode (no GOOGLE_CLIENT_ID on the server, reported by
 * GET /api/me as `auth: "single-operator"`) the server treats every request as the operator and the UI shows no
 * sign-in; with Google configured, Settings offers "Sign in with Google".
 */
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost:8787" : window.location.origin,
  basePath: "/api/auth",
});
