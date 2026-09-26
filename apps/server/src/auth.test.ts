import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createServerAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { openDatabase, type OpenDatabase } from "./db/index.js";

const opened: OpenDatabase[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function redirectFor(provider: "google" | "github") {
  const config = loadConfig({
    DATA_DIR: `/tmp/vb-social-${provider}-${randomBytes(6).toString("hex")}`,
    PUBLIC_URL: "http://127.0.0.1:8898",
    HOST: "127.0.0.1",
    PORT: "8898",
    GOOGLE_CLIENT_ID: provider === "google" ? "google-test-id" : undefined,
    GOOGLE_CLIENT_SECRET: provider === "google" ? "google-test-secret" : undefined,
    GITHUB_CLIENT_ID: provider === "github" ? "github-test-id" : undefined,
    GITHUB_CLIENT_SECRET: provider === "github" ? "github-test-secret" : undefined,
  });
  const database = openDatabase(config.dataDir);
  opened.push(database);
  const auth = createServerAuth(config, database.db).auth;
  return auth.api.signInSocial({ body: { provider, callbackURL: "/login" } });
}

describe("social sign-in configuration", () => {
  it("builds a GitHub authorization redirect without network access", async () => {
    const result = await redirectFor("github");
    expect(result.url).toContain("github.com/login/oauth/authorize");
    expect(result.url).toContain("client_id=github-test-id");
    expect(new URL(result.url ?? "").searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8898/api/auth/callback/github");
  });

  it("builds a Google authorization redirect without network access", async () => {
    const result = await redirectFor("google");
    expect(result.url).toContain("accounts.google.com");
    expect(result.url).toContain("client_id=google-test-id");
    expect(new URL(result.url ?? "").searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8898/api/auth/callback/google");
  });
});
