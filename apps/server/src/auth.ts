import type { IncomingHttpHeaders } from "node:http";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth, BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { ServerConfig } from "./config.js";
import type { DB } from "./db/schema.js";
import { account, session, user, verification } from "./db/schema.js";

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
      schema: { user, session, account, verification },
    }),
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: {
        httpOnly: true,
        secure,
        sameSite: "lax",
      },
    },
    socialProviders: config.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
          },
        }
      : undefined,
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
      'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT("id") DO UPDATE SET "name" = excluded."name", "updatedAt" = excluded."updatedAt"',
    )
    .run("operator", "Operator", "operator@localhost", 1, now, now);
}
