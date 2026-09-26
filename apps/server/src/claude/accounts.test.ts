import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenDatabase } from "../db/index.js";
import { createClaudeAccountService, type ClaudeAccountService } from "./accounts.js";

/** Claude's token endpoint and profile, stood in for: records the token exchanges, answers like Anthropic does. */
function stubAnthropicAuth(): { exchanges: Record<string, string>[] } {
  const exchanges: Record<string, string>[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://platform.claude.com/v1/oauth/token") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      exchanges.push(body);
      if (body.code === "rejected-code") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return Response.json({ access_token: `sk-ant-oat01-${body.code}`, refresh_token: `sk-ant-ort01-${body.code}`, expires_in: 28_800 });
    }
    if (url === "https://api.anthropic.com/api/oauth/profile") return Response.json({ account: { email: "flight@example.com" }, organization: { name: "Mission Control" } });
    return realFetch(input, init);
  });
  return { exchanges };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("Claude account connection (pi-ai sign-in, credentials in the database)", () => {
  let dir: string;
  let opened: OpenDatabase;
  let service: ClaudeAccountService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vb-claude-"));
    opened = openDatabase(dir);
    service = createClaudeAccountService({ config: {}, db: opened.db, log: pino({ level: "silent" }) });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const user of ["alice", "bob"]) {
      const pending = (await service.view(user)).pending;
      if (pending) await service.cancel(user, pending.loginId);
      await service.disconnect(user);
    }
  });

  afterAll(async () => {
    await service.stop();
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a browser on another machine pastes the redirect address back; the sign-in is saved for that user only", async () => {
    const { exchanges } = stubAnthropicAuth();
    const { loginId, url } = await service.start("alice");
    expect(url.startsWith("https://claude.ai/oauth/authorize?")).toBe(true);
    expect((await service.view("alice")).pending).toMatchObject({ loginId, url });

    const pasted = `http://localhost:53692/callback?code=pasted-code&state=${stateOf(url)}`;
    const view = await service.complete("alice", loginId, pasted);
    expect(view).toMatchObject({ connected: true, using: "claude-account", email: "flight@example.com", orgName: "Mission Control" });
    expect(view.pending).toBeUndefined();
    expect(exchanges).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "pasted-code", state: stateOf(url), code_verifier: stateOf(url) })]);
    expect(await service.credentials("alice").read("anthropic")).toMatchObject({ type: "oauth", access: "sk-ant-oat01-pasted-code", refresh: "sk-ant-ort01-pasted-code" });
    expect(await service.credentials("bob").read("anthropic")).toBeUndefined();
    expect((await service.view("bob")).connected).toBe(false);
  });

  it("accepts the code#state form, and refuses a code from a different sign-in with a clear error", async () => {
    stubAnthropicAuth();
    const first = await service.start("alice");
    await expect(service.complete("alice", first.loginId, "some-code#not-this-sign-in")).rejects.toMatchObject({ status: 400, code: "login_state_mismatch" });
    expect((await service.view("alice")).connected).toBe(false);

    const second = await service.start("alice");
    expect(second.loginId).not.toBe(first.loginId);
    expect((await service.complete("alice", second.loginId, `hash-code#${stateOf(second.url)}`)).connected).toBe(true);
  });

  it("a code Claude rejects ends the sign-in with the reason, and nothing is stored", async () => {
    stubAnthropicAuth();
    const { loginId, url } = await service.start("alice");
    await expect(service.complete("alice", loginId, `rejected-code#${stateOf(url)}`)).rejects.toMatchObject({ status: 400, code: "login_failed", message: expect.stringContaining("Claude sign-in didn't finish") });
    expect(await service.credentials("alice").read("anthropic")).toBeUndefined();
    await expect(service.complete("alice", loginId, "again")).rejects.toMatchObject({ status: 404, code: "login_not_found" });
  });

  it("a browser on this machine finishes through the local callback, without a paste", async () => {
    stubAnthropicAuth();
    const { loginId, url } = await service.start("alice");
    const callback = await fetch(`http://127.0.0.1:53692/callback?code=callback-code&state=${stateOf(url)}`);
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
