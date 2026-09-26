import type { IncomingHttpHeaders } from "node:http";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Auth, BetterAuthOptions } from "better-auth";
import type { ServerConfig } from "./config.js";
import type { DB } from "./db/schema.js";
import { account, jwks, oauthAccessToken, oauthClient, oauthClientAssertion, oauthClientResource, oauthConsent, oauthRefreshToken, oauthResource, session, user, verification } from "./db/schema.js";

export interface ServerAuth {
  auth: Auth<BetterAuthOptions>;
  handler: Auth<BetterAuthOptions>["handler"];
}

export function createServerAuth(config: ServerConfig, db: DB): ServerAuth {
  const secure = config.publicUrl.startsWith("https://");
  const options: BetterAuthOptions = {
    appName: "ViBread",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user,
        session,
        account,
        verification,
        jwks,
        oauthClient,
        oauthResource,
        oauthClientResource,
        oauthRefreshToken,
        oauthAccessToken,
        oauthConsent,
        oauthClientAssertion,
      },
    }),
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: {
        httpOnly: true,
        secure,
        sameSite: "lax",
      },
    },
    socialProviders: {
      ...(config.google ? { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret } } : {}),
      ...(config.github ? { github: { clientId: config.github.clientId, clientSecret: config.github.clientSecret } } : {}),
    },
    emailAndPassword: { enabled: true, disableSignUp: true, autoSignIn: true, requireEmailVerification: false },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${config.publicUrl}/mcp`,
        scopes: ["circuits:read", "circuits:write", "bench:request"],
        allowUnauthenticatedClientRegistration: true,
        allowDynamicClientRegistration: true,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  };
  const auth = betterAuth(options);
  return { auth: auth as Auth<BetterAuthOptions>, handler: auth.handler };
}

export async function getSessionUser(
  auth: ServerAuth["auth"],
  headers: IncomingHttpHeaders,
): Promise<{ id: string; name: string; email?: string; image?: string } | null> {
  const sessionResult = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!sessionResult?.user) return null;
  return {
    id: sessionResult.user.id,
    name: sessionResult.user.name,
    email: sessionResult.user.email,
    image: sessionResult.user.image ?? undefined,
  };
}

export function ensureOperatorUser(sqlite: SqliteDatabase): void {
  const now = Date.now();
  sqlite
    .prepare(
      'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT("id") DO UPDATE SET "name" = excluded."name", "email" = excluded."email", "emailVerified" = excluded."emailVerified", "updatedAt" = excluded."updatedAt"',
    )
    .run("operator", "Operator", "operator@vibread.local", 1, now, now);
}
