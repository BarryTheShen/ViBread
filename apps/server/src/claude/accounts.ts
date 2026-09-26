/**
 * PLAN item 16 — "Connect your Claude account", on pi-ai's own Anthropic auth (no auth code of ours, no helper process):
 *   - sign-in: pi-ai's Anthropic OAuth flow (`Models.login("anthropic", "oauth")`). The claude.ai address goes to the
 *     browser; the person pastes the code or the final redirect address back (so it works when the browser is on another
 *     machine), or the flow's own local callback finishes it when the browser runs on this machine;
 *   - or an Anthropic API key;
 *   - the credential lives in the database (`claude_accounts`, one row per user) behind pi-ai's CredentialStore contract,
 *     and pi-ai refreshes OAuth tokens through it. No files and no HOME/USERPROFILE: the same on Windows, macOS and Linux.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, type AuthContext, type AuthInteraction, type Credential, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ClaudeAccountView } from "@vibread/core";
import { errorMessage } from "@vibread/tools";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { ServerConfig } from "../config.js";
import { claudeAccounts, type DB } from "../db/schema.js";

/** pi-ai's provider id for Claude; the only credential a ViBread user stores. */
export const CLAUDE_PROVIDER = "anthropic";

/** Auth never falls back to the server process's environment or files: a user's calls use only their own credential. */
export const NO_AMBIENT_AUTH: AuthContext = { env: async () => undefined, fileExists: async () => false };

/** A pi-ai model collection with Claude, authenticated only by `credentials`. */
export function claudeModels(credentials: CredentialStore): MutableModels {
  const models = createModels({ credentials, authContext: NO_AMBIENT_AUTH });
  models.setProvider(anthropicProvider());
  return models;
}

export interface ClaudeAccountService {
  view(userId: string): Promise<ClaudeAccountView>;
  /** Starts the Claude sign-in; resolves with the claude.ai address to open. */
  start(userId: string): Promise<{ loginId: string; url: string }>;
  /** Finishes a sign-in with the pasted code or final redirect address (or confirms one the local callback completed). */
  complete(userId: string, loginId: string, code: string): Promise<ClaudeAccountView>;
  cancel(userId: string, loginId: string): Promise<void>;
  /** Connects with an Anthropic API key instead of a Claude sign-in. */
  saveApiKey(userId: string, key: string): Promise<ClaudeAccountView>;
  disconnect(userId: string): Promise<ClaudeAccountView>;
  /** The user's stored Claude credential (pi-ai CredentialStore over the database), for models.ts. */
  credentials(userId: string): CredentialStore;
  stop(): Promise<void>;
}

export class ClaudeAccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PendingLogin {
  id: string;
  userId: string;
  url: string;
  startedAt: number;
  abort: AbortController;
  /** Resolves pi-ai's "paste the code" prompt. */
  paste: PromiseWithResolvers<string>;
  /** pi-ai's login: resolves once the credential is saved. */
  done: Promise<void>;
}

const LOGIN_TTL_MS = 10 * 60_000;
/** Longest wait for the claude.ai address, and for the token exchange after a paste. */
const STEP_TIMEOUT_MS = 30_000;
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** The first sentence of a pi-ai login error, without its URLs and response dumps. */
function loginReason(error: unknown): string {
  return errorMessage(error).split(/\.\s|;/)[0]!.trim();
}

export function createClaudeAccountService(deps: { config: Pick<ServerConfig, "anthropicApiKey">; db: DB; log: Logger }): ClaudeAccountService {
  const { db, config } = deps;
  const log = deps.log.child({ component: "claude-accounts" });
  const pending = new Map<string, PendingLogin>();
  /** Per-user write chain: CredentialStore.modify is a serialized read-modify-write (OAuth refresh runs inside it). */
  const chains = new Map<string, Promise<unknown>>();

  const accountFor = (userId: string) => db.select().from(claudeAccounts).where(eq(claudeAccounts.userId, userId)).get();

  function serialized<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const run = (chains.get(userId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    chains.set(userId, tail);
    void tail.then(() => {
      if (chains.get(userId) === tail) chains.delete(userId);
    });
    return run;
  }

  function credentials(userId: string): CredentialStore {
    const read = async (providerId: string): Promise<Credential | undefined> => {
      if (providerId !== CLAUDE_PROVIDER) return undefined;
      const row = accountFor(userId);
      return row ? (JSON.parse(row.credential) as Credential) : undefined;
    };
    return {
      read,
      async list() {
        const current = await read(CLAUDE_PROVIDER);
        return current ? [{ providerId: CLAUDE_PROVIDER, type: current.type }] : [];
      },
      modify(providerId, fn) {
        if (providerId !== CLAUDE_PROVIDER) return Promise.reject(new Error(`ViBread stores only Claude credentials, not ${providerId}.`));
        return serialized(userId, async () => {
          const current = await read(providerId);
          const next = await fn(current);
          if (!next) return current;
          const row = { userId, credential: JSON.stringify(next), connectedAt: accountFor(userId)?.connectedAt ?? new Date() };
          db.insert(claudeAccounts).values(row).onConflictDoUpdate({ target: claudeAccounts.userId, set: { credential: row.credential } }).run();
          return next;
        });
      },
      delete(providerId) {
        if (providerId !== CLAUDE_PROVIDER) return Promise.resolve();
        return serialized(userId, async () => {
          db.delete(claudeAccounts).where(eq(claudeAccounts.userId, userId)).run();
        });
      },
    };
  }

  /** Account name for Settings and the timeline, from the Claude profile the new token can read. Best effort. */
  async function recordProfile(userId: string): Promise<void> {
    const credential = await credentials(userId).read(CLAUDE_PROVIDER);
    if (credential?.type !== "oauth") return;
    try {
      const response = await fetch(PROFILE_URL, {
        headers: { authorization: `Bearer ${credential.access}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`profile request failed: ${response.status}`);
      const profile = (await response.json()) as { account?: { email?: string; email_address?: string }; organization?: { name?: string } };
      const email = profile.account?.email ?? profile.account?.email_address ?? null;
      const orgName = profile.organization?.name ?? null;
      db.update(claudeAccounts).set({ email, orgName }).where(eq(claudeAccounts.userId, userId)).run();
    } catch (error) {
      log.warn({ err: errorMessage(error), userId }, "couldn't read the Claude account profile");
    }
  }

  function reapPending(): void {
    const now = Date.now();
    for (const login of pending.values()) {
      if (now - login.startedAt < LOGIN_TTL_MS) continue;
      pending.delete(login.id);
      login.abort.abort();
    }
  }

  function pendingFor(userId: string): PendingLogin | undefined {
    reapPending();
    for (const login of pending.values()) if (login.userId === userId) return login;
    return undefined;
  }

  async function view(userId: string): Promise<ClaudeAccountView> {
    const account = accountFor(userId);
    const login = pendingFor(userId);
    return {
      connected: Boolean(account),
      email: account?.email ?? undefined,
      orgName: account?.orgName ?? undefined,
      connectedAt: account?.connectedAt.toISOString(),
      pending: login ? { loginId: login.id, url: login.url, startedAt: new Date(login.startedAt).toISOString() } : undefined,
      using: account ? "claude-account" : config.anthropicApiKey ? "server-key" : "none",
    };
  }

  return {
    view,
    credentials,

    async start(userId) {
      const existing = pendingFor(userId);
      if (existing) return { loginId: existing.id, url: existing.url };
      // pi-ai's sign-in listens for the local callback on one fixed port, so one sign-in runs at a time.
      if (pending.size > 0) throw new ClaudeAccountError(409, "login_busy", "Someone else is connecting a Claude account right now. It should free up within 10 minutes.");
      const abort = new AbortController();
      const paste = Promise.withResolvers<string>();
      const address = Promise.withResolvers<string>();
      const interaction: AuthInteraction = {
        signal: abort.signal,
        notify(event) {
          if (event.type === "auth_url") address.resolve(event.url);
        },
        prompt(prompt) {
          if (prompt.type !== "manual_code") return Promise.reject(new Error(`Unexpected sign-in question: ${prompt.message}`));
          const stop = () => paste.reject(new Error("Sign-in cancelled."));
          prompt.signal?.addEventListener("abort", stop, { once: true });
          abort.signal.addEventListener("abort", stop, { once: true });
          return paste.promise;
        },
      };
      // A rejected paste after the local callback won is expected; pi-ai handles it.
      paste.promise.catch(() => undefined);
      const done = claudeModels(credentials(userId))
        .login(CLAUDE_PROVIDER, "oauth", interaction)
        .then(async () => {
          await recordProfile(userId);
          log.info({ userId }, "Claude account connected");
        });
      done.catch((error: unknown) => address.reject(error));
      const url = await Promise.race([
        address.promise,
        sleep(STEP_TIMEOUT_MS, undefined, { ref: false }).then(() => {
          throw new Error("no sign-in address");
        }),
      ]).catch((error: unknown) => {
        abort.abort();
        log.warn({ err: errorMessage(error), userId }, "Claude sign-in couldn't start");
        throw new ClaudeAccountError(503, "login_unavailable", `Claude sign-in couldn't start: ${loginReason(error)}. Try again in a moment.`);
      });
      const login: PendingLogin = { id: randomUUID(), userId, url, startedAt: Date.now(), abort, paste, done };
      pending.set(login.id, login);
      // Finished (local callback, paste, or failure) → no longer pending.
      void done.then(
        () => pending.delete(login.id),
        (error: unknown) => {
          pending.delete(login.id);
          if (!abort.signal.aborted) log.warn({ err: errorMessage(error), userId }, "Claude sign-in failed");
        },
      );
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
      login.paste.resolve(input);
      const outcome = await Promise.race([
        login.done.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        sleep(STEP_TIMEOUT_MS, undefined, { ref: false }).then(() => ({ ok: false as const, error: new Error("the token exchange timed out") })),
      ]);
      pending.delete(loginId);
      if (!outcome.ok) {
        login.abort.abort();
        if (/state mismatch/i.test(errorMessage(outcome.error))) {
          throw new ClaudeAccountError(400, "login_state_mismatch", "That code is from a different sign-in attempt. Use the newest Claude link and paste its code.");
        }
        throw new ClaudeAccountError(400, "login_failed", `Claude sign-in didn't finish: ${loginReason(outcome.error)}. Start again and paste the newest code.`);
      }
      return view(userId);
    },

    async cancel(userId, loginId) {
      const login = pending.get(loginId);
      if (!login || login.userId !== userId) return;
      pending.delete(loginId);
      login.abort.abort();
    },

    async saveApiKey(userId, key) {
      const trimmed = key.trim();
      if (!trimmed) throw new ClaudeAccountError(400, "key_required", "Paste your Anthropic API key.");
      await claudeModels(credentials(userId)).login(CLAUDE_PROVIDER, "api_key", {
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
        notify: () => undefined,
        prompt: async () => trimmed,
      });
      db.update(claudeAccounts).set({ email: null, orgName: null }).where(eq(claudeAccounts.userId, userId)).run();
      log.info({ userId }, "Claude connected with an API key");
      return view(userId);
    },

    async disconnect(userId) {
      await claudeModels(credentials(userId)).logout(CLAUDE_PROVIDER);
      return view(userId);
    },

    async stop() {
      for (const login of pending.values()) login.abort.abort();
      pending.clear();
    },
  };
}
