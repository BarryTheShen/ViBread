import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  singleOperator: boolean;
  google?: { clientId: string; clientSecret: string };
  authSecret: string;
  anthropicApiKey?: string;
  model: string;
  fastModel: string;
  approvalSecret: string;
  capcom: { provider: "cloud" | "terminal" | "off"; projectId?: string; projectSecret?: string; number?: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.PORT);
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (googleClientId && !googleClientSecret) throw new Error("GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set");
  const provider = env.CAPCOM_PROVIDER ?? "off";
  if (provider !== "off" && provider !== "terminal" && provider !== "cloud") throw new Error(`invalid CAPCOM_PROVIDER: ${provider}`);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dataDir,
    singleOperator: !googleClientId,
    google: googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : undefined,
    authSecret: env.BETTER_AUTH_SECRET?.trim() || readOrCreateSecret(dataDir, "better-auth-secret"),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: env.VIBREAD_MODEL?.trim() || "claude-opus-5-5",
    fastModel: env.VIBREAD_FAST_MODEL?.trim() || "claude-sonnet-5",
    approvalSecret: env.VIBREAD_APPROVAL_SECRET?.trim() || readOrCreateSecret(dataDir, "approval-secret"),
    capcom: {
      provider,
      projectId: env.PHOTON_PROJECT_ID?.trim() || undefined,
      projectSecret: env.PHOTON_PROJECT_SECRET?.trim() || undefined,
      number: env.CAPCOM_NUMBER?.trim() || undefined,
    },
  };
}

function parsePort(raw: string | undefined): number {
  const port = raw === undefined ? 8787 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid PORT: ${raw ?? ""}`);
  return port;
}

function readOrCreateSecret(dataDir: string, name: string): string {
  const path = resolve(dataDir, `.${name}`);
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= 32) return stored;
  }
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}
