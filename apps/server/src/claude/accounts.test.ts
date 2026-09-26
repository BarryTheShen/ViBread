import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenDatabase } from "../db/index.js";
import { createClaudeAccountService, type ClaudeAccountService } from "./accounts.js";

/** Anthropic's OAuth token endpoint (pi-ai posts the code exchange there); the tests point it at a local stand-in. */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

interface TokenStub {
  url: string;
  exchanges: Record<string, string>[];
  server: Server;
}

/** Stand-in for Claude's token endpoint: records the exchanges and answers like Anthropic does. */
async function tokenStub(): Promise<TokenStub> {
  const exchanges: Record<string, string>[] = [];
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, string>;
      exchanges.push(body);
      res.writeHead(body.code === "rejected-code" ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.code === "rejected-code" ? { error: "invalid_grant" } : { access_token: `sk-ant-oat01-${body.code}`, refresh_token: `sk-ant-ort01-${body.code}`, expires_in: 28_800 }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the token stand-in isn't listening on a port");
  return { url: `http://127.0.0.1:${address.port}/v1/oauth/token`, exchanges, server };
}

/** Claude's profile (read by the server after a sign-in), stood in for. */
function stubProfile(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.anthropic.com/api/oauth/profile") return Response.json({ account: { email: "flight@example.com" }, organization: { name: "Mission Control" } });
    return realFetch(input, init);
  });
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

/** A port nothing listens on, so pi-ai's local sign-in callback never needs localhost:53692 in tests. */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("the port probe isn't listening on a port");
  const { port } = address;
  probe.close();
  await once(probe, "close");
  return port;
}

describe("Claude account connection (pi-ai sign-in, credentials in the database)", () => {
  let dir: string;
  let opened: OpenDatabase;
  let service: ClaudeAccountService;
  let callbackPort: number;
  let token: TokenStub;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-claude-"));
    opened = openDatabase(dir);
    callbackPort = await freePort();
    token = await tokenStub();
    service = createClaudeAccountService({ config: {}, db: opened.db, log: pino({ level: "silent" }), signIn: { callbackPort, rewrite: { from: TOKEN_URL, to: token.url } } });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    token.exchanges.length = 0;
    for (const user of ["alice", "bob"]) {
      const pending = (await service.view(user)).pending;
      if (pending) await service.cancel(user, pending.loginId);
      await service.disconnect(user);
    }
  });

  afterAll(async () => {
    await service.stop();
    token.server.close();
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a browser on another machine pastes the redirect address back; the sign-in is saved for that user only", async () => {
    stubProfile();
    const { loginId, url } = await service.start("alice");
    expect(url.startsWith("https://claude.ai/oauth/authorize?")).toBe(true);
    expect((await service.view("alice")).pending).toMatchObject({ loginId, url });

    const pasted = `http://localhost:53692/callback?code=pasted-code&state=${stateOf(url)}`;
    const view = await service.complete("alice", loginId, pasted);
    expect(view).toMatchObject({ connected: true, using: "claude-account", email: "flight@example.com", orgName: "Mission Control" });
    expect(view.pending).toBeUndefined();
    expect(token.exchanges).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "pasted-code", state: stateOf(url), code_verifier: stateOf(url) })]);
    expect(await service.credentials("alice").read("anthropic")).toMatchObject({ type: "oauth", access: "sk-ant-oat01-pasted-code", refresh: "sk-ant-ort01-pasted-code" });
    expect(await service.credentials("bob").read("anthropic")).toBeUndefined();
    expect((await service.view("bob")).connected).toBe(false);
  });

  it("accepts the code#state form, and refuses a code from a different sign-in with a clear error", async () => {
    stubProfile();
    const first = await service.start("alice");
    await expect(service.complete("alice", first.loginId, "some-code#not-this-sign-in")).rejects.toMatchObject({ status: 400, code: "login_state_mismatch" });
    expect((await service.view("alice")).connected).toBe(false);

    const second = await service.start("alice");
    expect(second.loginId).not.toBe(first.loginId);
    expect((await service.complete("alice", second.loginId, `hash-code#${stateOf(second.url)}`)).connected).toBe(true);
  });

  it("a code Claude rejects ends the sign-in with the reason, and nothing is stored", async () => {
    stubProfile();
    const { loginId, url } = await service.start("alice");
    await expect(service.complete("alice", loginId, `rejected-code#${stateOf(url)}`)).rejects.toMatchObject({ status: 400, code: "login_failed", message: expect.stringContaining("Claude sign-in didn't finish") });
    expect(await service.credentials("alice").read("anthropic")).toBeUndefined();
    await expect(service.complete("alice", loginId, "again")).rejects.toMatchObject({ status: 404, code: "login_not_found" });
  });

  it("a browser on this machine finishes through the local callback, without a paste", async () => {
    stubProfile();
    const { loginId, url } = await service.start("alice");
    const callback = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=callback-code&state=${stateOf(url)}`);
    expect(callback.status).toBe(200);
    await vi.waitFor(async () => expect((await service.view("alice")).connected).toBe(true));
    expect((await service.view("alice")).pending).toBeUndefined();
    // The page's "complete" call after the callback won just confirms.
    expect((await service.complete("alice", loginId, "ignored")).connected).toBe(true);
  });

  it("one sign-in runs at a time; cancelling frees it", async () => {
    const alice = await service.start("alice");
    expect((await service.start("alice")).loginId).toBe(alice.loginId);
    await expect(service.start("bob")).rejects.toMatchObject({ status: 409, code: "login_busy" });
    await service.cancel("alice", alice.loginId);
    expect((await service.view("alice")).pending).toBeUndefined();
    const bob = await service.start("bob");
    expect(bob.url.startsWith("https://claude.ai/oauth/authorize?")).toBe(true);
  });

  it("connects with an API key, and disconnecting removes the stored credential", async () => {
    await expect(service.saveApiKey("bob", "  ")).rejects.toMatchObject({ status: 400, code: "key_required" });
    expect(await service.saveApiKey("bob", " sk-ant-api03-bob ")).toMatchObject({ connected: true, using: "claude-account" });
    expect(await service.credentials("bob").read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-api03-bob" });
    expect(await service.disconnect("bob")).toMatchObject({ connected: false, using: "none" });
    expect(await service.credentials("bob").read("anthropic")).toBeUndefined();
  });

  it("credential writes are serialized per user, so a token refresh never loses a concurrent write", async () => {
    const store = service.credentials("alice");
    await store.modify("anthropic", async () => ({ type: "api_key", key: "0" }));
    const bump = () =>
      store.modify("anthropic", async (current) => {
        const n = Number((current as { key: string }).key);
        await yieldTurn();
        return { type: "api_key", key: String(n + 1) };
      });
    await Promise.all([bump(), bump(), bump()]);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "3" });
    await expect(store.modify("openai", async () => ({ type: "api_key", key: "x" }))).rejects.toThrow("only Claude credentials");
  });
});
