/**
 * PLAN item 16 — "Connect your Claude account", built on oh-my-pi's own auth setup (no auth code of ours):
 *   - `omp login anthropic` runs the Claude account OAuth flow (URL out on stdout, pasted code/redirect in on stdin, or the
 *     local callback on :54545 when the browser runs on this machine) and saves the grant into an `omp auth-broker`;
 *   - `omp auth-broker serve` holds the grants and refreshes them;
 *   - one `omp auth-gateway serve` per connected user, restricted to that user's account with an account-pool file,
 *     exposes an Anthropic Messages endpoint the agents' AI SDK provider talks to (`baseURL` + bearer).
 * Everything omp touches lives under DATA_DIR/claude-accounts (its own HOME), never the operator's ~/.omp.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { ClaudeAccountView } from "@vibread/core";
import type { ServerConfig } from "../config.js";
import { claudeAccounts, type DB } from "../db/schema.js";

export interface ClaudeEndpoint {
  baseURL: string;
  authToken: string;
}

export interface ClaudeAccountService {
  view(userId: string): Promise<ClaudeAccountView>;
  /** Starts the Claude sign-in; resolves once oh-my-pi printed the authorization URL. */
  start(userId: string): Promise<{ loginId: string; url: string }>;
  /** Finishes a sign-in with the pasted code or final redirect URL (or confirms one the local callback completed). */
  complete(userId: string, loginId: string, code: string): Promise<ClaudeAccountView>;
  cancel(userId: string, loginId: string): Promise<void>;
  disconnect(userId: string): Promise<ClaudeAccountView>;
  /** The user's own Claude endpoint for agent calls, or undefined (not connected / not usable) → the server key is used. */
  endpointFor(userId: string, model: string): Promise<ClaudeEndpoint | undefined>;
  stop(): Promise<void>;
}

/** Snapshot entry fields we read from `GET /v1/snapshot` (oh-my-pi auth-broker wire format). */
interface BrokerEntry {
  id: number;
  provider: string;
  identityKey: string | null;
  credential: { type?: string; email?: string; orgName?: string };
}

interface PendingLogin {
  id: string;
  userId: string;
  url: string;
  child: ChildProcessWithoutNullStreams;
  before: Set<number>;
  startedAt: number;
  exit: Promise<{ code: number | null; output: string }>;
  stateMismatch: Promise<void>;
  inputSent: { value: boolean };
  bound?: Promise<void>;
}

const PROVIDER = "anthropic";
const LOGIN_TTL_MS = 10 * 60_000;
const AUTHORIZE_URL = /https:\/\/claude\.ai\/oauth\/authorize\?\S+/;
const PASTE_PROMPT = /Paste the authorization code \(or full redirect URL\):/g;


export class ClaudeAccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** oh-my-pi reads provider keys and its own config from the environment; children get a clean, isolated one. */
const OMP_ENVIRONMENT_KEYS: Record<string, true> = {
  PATH: true,
  TMPDIR: true,
  TMP: true,
  TEMP: true,
  LANG: true,
  LC_ALL: true,
  TERM: true,
  SSL_CERT_FILE: true,
  SSL_CERT_DIR: true,
  NODE_EXTRA_CA_CERTS: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  NO_PROXY: true,
  http_proxy: true,
  https_proxy: true,
  no_proxy: true,
  SYSTEMROOT: true,
  USERPROFILE: true,
  APPDATA: true,
  LOCALAPPDATA: true,
};

export function ompEnvironment(base: NodeJS.ProcessEnv, home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (OMP_ENVIRONMENT_KEYS[key] && value !== undefined) env[key] = value;
  }
  return { ...env, HOME: home, ...extra };
}

/** Picks the broker credential a finished login produced: a new row, else the account this user already had. */
export function pickLoginCredential(
  entries: BrokerEntry[],
  before: Set<number>,
  boundToOthers: Set<number>,
  previous?: number,
): BrokerEntry | undefined {
  const mine = entries.filter((entry) => entry.provider === PROVIDER && entry.identityKey && !boundToOthers.has(entry.id));
  const fresh = mine.filter((entry) => !before.has(entry.id));
  if (fresh.length === 1) return fresh[0];
  if (previous !== undefined) {
    const same = mine.find((entry) => entry.id === previous);
    if (same) return same;
  }
  return undefined;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
  });
  return promise;
}

async function waitHealthy(url: string, child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

export function createClaudeAccountService(deps: { config: ServerConfig; db: DB; log: Logger }): ClaudeAccountService {
  const { ompBin, home } = deps.config.claudeAccounts;
  const ompDir = join(home, ".omp");
  const brokerPidFile = join(home, "auth-broker.pid");
  const log = deps.log.child({ component: "claude-accounts" });
  let available: boolean | undefined;
  let broker: Promise<void> | undefined;
  let brokerChild: ChildProcessWithoutNullStreams | undefined;
  let brokerListenPort: number | undefined;
  const gateways = new Map<string, Promise<{ child: ChildProcessWithoutNullStreams; endpoint: ClaudeEndpoint }>>();
  const pending = new Map<string, PendingLogin>();
  const children = new Set<ChildProcessWithoutNullStreams>();

  mkdirSync(home, { recursive: true });
  let oldBrokerPid = 0;
  try {
    oldBrokerPid = Number(readFileSync(brokerPidFile, "utf8").trim() || 0);
  } catch {
    // No prior ViBread broker was recorded.
  }
  if (Number.isInteger(oldBrokerPid) && oldBrokerPid > 0) {
    const command = spawnSync("ps", ["-p", String(oldBrokerPid), "-o", "command="], { encoding: "utf8" });
    const commandLine = command.status === 0 ? command.stdout.trim() : "";
    const executable = basename(ompBin);
    const isOmp = commandLine.split(/\s+/).some((token) => basename(token) === "omp" || basename(token) === executable);
    if (isOmp && commandLine.includes("auth-broker")) {
      try {
        process.kill(oldBrokerPid, "SIGTERM");
      } catch {
        // The recorded process may have exited between ps and kill.
      }
    }
  }

  const brokerUnavailable = () =>
    new ClaudeAccountError(503, "broker_unavailable", "Claude sign-in isn't available right now. Try again in a moment.");
  const brokerUrl = () => {
    if (brokerListenPort === undefined) throw brokerUnavailable();
    return `http://127.0.0.1:${brokerListenPort}`;
  };

  function isAvailable(): boolean {
    available ??= spawnSync(ompBin, ["--version"], { env: ompEnvironment(process.env, home), timeout: 20_000 }).status === 0;
    return available;
  }

  function run(args: string[], extra: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    mkdirSync(home, { recursive: true });
    const child = spawn(ompBin, args, { env: ompEnvironment(process.env, home, extra), stdio: "pipe" });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  }

  const brokerToken = () => {
    try {
      return readFileSync(join(ompDir, "auth-broker.token"), "utf8").trim();
    } catch {
      throw brokerUnavailable();
    }
  };

  function ensureBroker(): Promise<void> {
    if (!broker) {
      const current = (async () => {
        const port = await freePort();
        brokerListenPort = port;
        const child = run(["auth-broker", "serve", `--bind=127.0.0.1:${port}`]);
        brokerChild = child;
        if (child.pid === undefined) throw new Error("auth-broker did not expose a pid");
        writeFileSync(brokerPidFile, `${child.pid}\n`, { mode: 0o600 });
        child.stderr.on("data", (chunk: Buffer) => log.debug({ stderr: chunk.toString() }, "auth-broker"));
        child.once("exit", (code) => {
          log.warn({ code }, "oh-my-pi auth-broker exited");
          if (brokerChild === child) {
            brokerChild = undefined;
            brokerListenPort = undefined;
            broker = undefined;
          }
          try {
            if (readFileSync(brokerPidFile, "utf8").trim() === String(child.pid)) rmSync(brokerPidFile, { force: true });
          } catch {
            // The pid file may already have been replaced by a newer broker.
          }
        });
        await waitHealthy(`${brokerUrl()}/v1/healthz`, child);
      })();
      broker = current;
      current.catch(() => {
        if (broker === current) {
          broker = undefined;
          brokerChild = undefined;
          brokerListenPort = undefined;
        }
      });
    }
    return broker;
  }

  async function brokerEntries(): Promise<BrokerEntry[]> {
    await ensureBroker();
    const child = brokerChild;
    if (!child || child.exitCode !== null) throw brokerUnavailable();
    const response = await fetch(`${brokerUrl()}/v1/snapshot`, { headers: { authorization: `Bearer ${brokerToken()}` } });
    if (!response.ok) throw new Error(`auth-broker snapshot failed: ${response.status}`);
    const body = (await response.json()) as { credentials?: BrokerEntry[] };
    return body.credentials ?? [];
  }

  const accountFor = (userId: string) => deps.db.select().from(claudeAccounts).where(eq(claudeAccounts.userId, userId)).get();

  function stopGateway(userId: string): void {
    const gateway = gateways.get(userId);
    gateways.delete(userId);
    void gateway?.then(({ child }) => child.kill("SIGTERM")).catch(() => undefined);
  }

  function ensureGateway(userId: string, identityKey: string): Promise<{ child: ChildProcessWithoutNullStreams; endpoint: ClaudeEndpoint }> {
    let gateway = gateways.get(userId);
    if (!gateway) {
      gateway = (async () => {
        await ensureBroker();
        const brokerEndpoint = brokerUrl();
        const brokerAuthToken = brokerToken();
        const pools = join(home, "pools");
        mkdirSync(pools, { recursive: true });
        const poolFile = join(pools, `${userId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
        writeFileSync(poolFile, JSON.stringify({ [PROVIDER]: [identityKey] }), { mode: 0o600 });
        const port = await freePort();
        const child = run(["auth-gateway", "serve", `--bind=127.0.0.1:${port}`], {
          OMP_AUTH_BROKER_URL: brokerEndpoint,
          OMP_AUTH_BROKER_TOKEN: brokerAuthToken,
          OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
          OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolFile,
        });
        child.once("exit", (code) => {
          log.warn({ code, userId }, "oh-my-pi auth-gateway exited");
          gateways.delete(userId);
        });
        await waitHealthy(`http://127.0.0.1:${port}/healthz`, child);
        const authToken = readFileSync(join(ompDir, "auth-gateway.token"), "utf8").trim();
        return { child, endpoint: { baseURL: `http://127.0.0.1:${port}/v1`, authToken } };
      })();
      gateways.set(userId, gateway);
      gateway.catch(() => gateways.delete(userId));
    }
    return gateway;
  }

  function reapPending(): void {
    const now = Date.now();
    for (const login of pending.values()) {
      if (login.child.exitCode === null && now - login.startedAt < LOGIN_TTL_MS) continue;
      pending.delete(login.id);
      if (login.child.exitCode === null) login.child.kill("SIGTERM");
    }
  }

  function pendingFor(userId: string): PendingLogin | undefined {
    for (const login of pending.values()) {
      if (login.userId !== userId) continue;
      if (Date.now() - login.startedAt < LOGIN_TTL_MS && login.child.exitCode === null) return login;
      pending.delete(login.id);
      if (login.child.exitCode === null) login.child.kill("SIGTERM");
    }
    return undefined;
  }

  async function view(userId: string): Promise<ClaudeAccountView> {
    if (!isAvailable()) return { available: false, connected: false, using: deps.config.anthropicApiKey ? "server-key" : "none" };
    const account = accountFor(userId);
    const login = pendingFor(userId);
    return {
      available: true,
      connected: Boolean(account),
      email: account?.email ?? undefined,
      orgName: account?.orgName ?? undefined,
      connectedAt: account?.connectedAt.toISOString(),
      pending: login ? { loginId: login.id, url: login.url, startedAt: new Date(login.startedAt).toISOString() } : undefined,
      using: account ? "claude-account" : deps.config.anthropicApiKey ? "server-key" : "none",
    };
  }

  async function bind(userId: string, login: PendingLogin): Promise<void> {
    const entries = await brokerEntries();
    const others = new Set(
      deps.db
        .select({ userId: claudeAccounts.userId, credentialId: claudeAccounts.credentialId })
        .from(claudeAccounts)
        .all()
        .filter((row) => row.userId !== userId)
        .map((row) => row.credentialId),
    );
    const entry = pickLoginCredential(entries, login.before, others, accountFor(userId)?.credentialId);
    if (!entry?.identityKey) throw new ClaudeAccountError(409, "claude_account_unknown", "Signed in, but ViBread couldn't tell which Claude account it was. Try again.");
    const row = {
      userId,
      credentialId: entry.id,
      identityKey: entry.identityKey,
      email: entry.credential.email ?? null,
      orgName: entry.credential.orgName ?? null,
      connectedAt: new Date(),
    };
    deps.db.insert(claudeAccounts).values(row).onConflictDoUpdate({ target: claudeAccounts.userId, set: row }).run();
    stopGateway(userId);
    log.info({ userId, credentialId: entry.id }, "Claude account connected");
  }

  return {
    view,

    async start(userId) {
      reapPending();
      if (!isAvailable()) throw new ClaudeAccountError(503, "omp_unavailable", "This server doesn't have oh-my-pi installed, so Claude accounts can't be connected here.");
      const existing = pendingFor(userId);
      if (existing) return { loginId: existing.id, url: existing.url };
      if (pending.size > 0) throw new ClaudeAccountError(409, "login_busy", "Someone else is connecting a Claude account right now. It should free up within 10 minutes.");
      const before = new Set((await brokerEntries()).map((entry) => entry.id));
      const brokerEndpoint = brokerUrl();
      const brokerAuthToken = brokerToken();
      const child = run(["login", PROVIDER], {
        OMP_AUTH_BROKER_URL: brokerEndpoint,
        OMP_AUTH_BROKER_TOKEN: brokerAuthToken,
        OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
        BROWSER: "true",
      });
      let output = "";
      let pastePrompts = 0;
      const inputSent = { value: false };
      const stateMismatch = Promise.withResolvers<void>();
      const exit = Promise.withResolvers<{ code: number | null; output: string }>();
      const printed = Promise.withResolvers<string>();
      const timer = setTimeout(() => printed.reject(new Error("oh-my-pi did not print a sign-in URL")), 20_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const seenPrompts = output.match(PASTE_PROMPT)?.length ?? 0;
        if (inputSent.value && seenPrompts >= 2 && seenPrompts > pastePrompts) stateMismatch.resolve();
        pastePrompts = seenPrompts;
        const match = AUTHORIZE_URL.exec(output);
        if (match) printed.resolve(match[0]);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => {
        printed.reject(new Error(`oh-my-pi login exited (${code}) before printing a sign-in URL`));
        exit.resolve({ code, output });
      });
      const url = await printed.promise.finally(() => clearTimeout(timer));
      const login: PendingLogin = {
        id: randomUUID(),
        userId,
        url,
        child,
        before,
        startedAt: Date.now(),
        exit: exit.promise,
        stateMismatch: stateMismatch.promise,
        inputSent,
      };
      pending.set(login.id, login);
      let exitedWhilePending = false;
      child.once("exit", () => {
        exitedWhilePending = pending.get(login.id) === login;
        pending.delete(login.id);
      });
      // The local callback (browser on this machine) finishes the login without a paste.
      void exit.promise.then(async ({ code }) => {
        if (code === 0 && exitedWhilePending) {
          login.bound ??= bind(userId, login);
          await login.bound.catch((error: unknown) => log.warn({ err: error }, "binding Claude account failed"));
        }
      });
      return { loginId: login.id, url };
    },

    async complete(userId, loginId, code) {
      const login = pending.get(loginId);
      if (!login || login.userId !== userId) {
        const current = await view(userId);
        if (current.connected) return current;
        throw new ClaudeAccountError(404, "login_not_found", "That sign-in expired. Start again.");
      }
      const input = code.trim();
      if (!input) throw new ClaudeAccountError(400, "code_required", "Paste the code or the address Claude sent you to.");
      if (login.child.exitCode === null) {
        login.inputSent.value = true;
        login.child.stdin.write(`${input}\n`);
      }
      const result = await Promise.race([
        login.exit.then(({ code: exitCode, output: exitOutput }) => ({ kind: "exit" as const, code: exitCode, output: exitOutput })),
        login.stateMismatch.then(() => ({ kind: "state_mismatch" as const })),
        sleep(20_000).then(() => null),
      ]);
      pending.delete(loginId);
      if (result?.kind === "state_mismatch") {
        login.child.kill("SIGTERM");
        throw new ClaudeAccountError(400, "login_state_mismatch", "That code is from a different sign-in attempt. Use the newest Claude link and paste its code.");
      }
      if (!result || result.kind !== "exit" || result.code !== 0) {
        login.child.kill("SIGTERM");
        const reason = result?.kind === "exit" ? result.output.split("\n").find((line) => /failed|error|invalid/i.test(line))?.trim() : undefined;
        throw new ClaudeAccountError(400, "login_failed", `Claude sign-in didn't finish${reason ? `: ${reason}` : ""}. Start again and paste the newest code.`);
      }
      login.bound ??= bind(userId, login);
      await login.bound;
      return view(userId);
    },

    async cancel(userId, loginId) {
      const login = pending.get(loginId);
      if (!login || login.userId !== userId) return;
      pending.delete(loginId);
      login.child.kill("SIGTERM");
    },

    async disconnect(userId) {
      const account = accountFor(userId);
      stopGateway(userId);
      if (account) {
        try {
          await ensureBroker();
          const brokerEndpoint = brokerUrl();
          const brokerAuthToken = brokerToken();
          await fetch(`${brokerEndpoint}/v1/credential/${account.credentialId}/disable`, {
            method: "POST",
            headers: { authorization: `Bearer ${brokerAuthToken}`, "content-type": "application/json" },
            body: JSON.stringify({ cause: "disconnected in ViBread" }),
          });
        } catch (error) {
          log.warn({ err: error }, "disabling the Claude credential failed");
        }
        deps.db.delete(claudeAccounts).where(eq(claudeAccounts.userId, userId)).run();
        rmSync(join(home, "pools", `${userId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), { force: true });
      }
      return view(userId);
    },

    async endpointFor(userId, model) {
      const account = accountFor(userId);
      if (!account || !isAvailable()) return undefined;
      try {
        const { endpoint } = await ensureGateway(userId, account.identityKey);
        // Pre-flight: the gateway lists only models it has a working credential for.
        const response = await fetch(`${endpoint.baseURL}/models`, { headers: { authorization: `Bearer ${endpoint.authToken}` } });
        const body = (await response.json()) as { data?: { id?: string }[] };
        if (!response.ok || !body.data?.some((entry) => entry.id === model || entry.id?.endsWith(`/${model}`))) {
          log.warn({ userId, model }, "Claude account can't serve the model; using the server key");
          return undefined;
        }
        return endpoint;
      } catch (error) {
        log.warn({ err: error, userId }, "Claude account gateway unavailable; using the server key");
        return undefined;
      }
    },

    async stop() {
      for (const login of pending.values()) login.child.kill("SIGTERM");
      pending.clear();
      for (const child of children) child.kill("SIGTERM");
      gateways.clear();
      broker = undefined;
    },
  };
}
