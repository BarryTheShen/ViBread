import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { fileURLToPath } from "node:url";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: string;
  phoneUrl: string;
  dataDir: string;
  singleOperator: boolean;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  authSecret: string;
  anthropicApiKey?: string;
  /** Anthropic Messages API base (AI SDK convention, ends in /v1): ANTHROPIC_BASE_URL, e.g. a proxy or a local bridge. */
  anthropicBaseUrl: string;
  model: string;
  fastModel: string;
  approvalSecret: string;
  capcom: { provider: "cloud" | "terminal" | "off"; projectId?: string; projectSecret?: string; number?: string };
  claudeAccounts: { ompBin: string; home: string };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.PORT);
  const publicUrl = trimUrl(env.PUBLIC_URL ?? `http://localhost:${port}`);
  validatePublicUrl(publicUrl);
  const phoneUrl = derivePhoneUrl({ publicUrl, port, configured: env.VIBREAD_PHONE_URL });
  // Relative DATA_DIR values resolve against the repo root, so the server (cwd apps/server) and root scripts share one store.
  const dataDir = resolve(REPO_ROOT, env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (googleClientId && !googleClientSecret) throw new Error("GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set");
  if (githubClientId && !githubClientSecret) throw new Error("GITHUB_CLIENT_SECRET is required when GITHUB_CLIENT_ID is set");
  const google = googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : undefined;
  const github = githubClientId && githubClientSecret ? { clientId: githubClientId, clientSecret: githubClientSecret } : undefined;
  const provider = env.CAPCOM_PROVIDER ?? "off";
  if (provider !== "off" && provider !== "terminal" && provider !== "cloud") throw new Error(`invalid CAPCOM_PROVIDER: ${provider}`);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl,
    phoneUrl,
    dataDir,
    singleOperator: !google && !github,
    google,
    github,
    authSecret: env.BETTER_AUTH_SECRET?.trim() || readOrCreateSecret(dataDir, "better-auth-secret"),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    anthropicBaseUrl: trimUrl(env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1"),
    model: env.VIBREAD_MODEL?.trim() || "claude-opus-5-5",
    fastModel: env.VIBREAD_FAST_MODEL?.trim() || "claude-sonnet-5",
    approvalSecret: env.VIBREAD_APPROVAL_SECRET?.trim() || readOrCreateSecret(dataDir, "approval-secret"),
    capcom: {
      provider,
      projectId: env.PHOTON_PROJECT_ID?.trim() || undefined,
      projectSecret: env.PHOTON_PROJECT_SECRET?.trim() || undefined,
      number: env.CAPCOM_NUMBER?.trim() || undefined,
    },
    claudeAccounts: {
      ompBin: env.VIBREAD_OMP_BIN?.trim() || "omp",
      home: resolve(dataDir, "claude-accounts"),
    },
  };
}

export interface PhoneUrlInputs {
  publicUrl: string;
  port: number;
  configured?: string;
}

export function derivePhoneUrl(
  input: PhoneUrlInputs,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const configured = input.configured?.trim();
  if (configured) return trimUrl(configured);
  const publicOrigin = new URL(input.publicUrl);
  if (publicOrigin.protocol === "https:" || !isLoopback(publicOrigin.hostname)) return input.publicUrl;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family;
      if (family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return `http://${entry.address}:${input.port}`;
      }
    }
  }
  return input.publicUrl;
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function validatePublicUrl(publicUrl: string): void {
  const parsed = new URL(publicUrl);
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error("PUBLIC_URL must be https:// (or localhost). For phones on your Wi-Fi, leave PUBLIC_URL unset — ViBread finds your LAN address — or set VIBREAD_PHONE_URL.");
  }
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
