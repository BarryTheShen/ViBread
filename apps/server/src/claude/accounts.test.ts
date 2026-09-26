import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDatabase, type OpenDatabase } from "../db/index.js";
import { createClaudeAccountService, ompEnvironment, pickLoginCredential, type ClaudeAccountService } from "./accounts.js";

const fakeOmp = new URL("./fake-omp.mjs", import.meta.url).pathname;

describe("Claude account connection (oh-my-pi broker + gateway)", () => {
  let dir: string;
  let opened: OpenDatabase;
  let service: ClaudeAccountService;

  beforeAll(() => {
    chmodSync(fakeOmp, 0o755);
    dir = mkdtempSync(join(tmpdir(), "vb-claude-"));
    const config = loadConfig({ DATA_DIR: dir, PORT: "8999" });
    config.claudeAccounts = { ompBin: fakeOmp, home: join(dir, "claude-accounts"), brokerPort: 20_000 + Math.floor(Math.random() * 20_000) };
    opened = openDatabase(config.dataDir);
    service = createClaudeAccountService({ config, db: opened.db, log: pino({ level: "silent" }) });
  });

  afterAll(async () => {
    await service.stop();
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("connects with a pasted code, routes the user's agents to their own gateway, and disconnects", async () => {
    expect(await service.view("alice")).toMatchObject({ available: true, connected: false, using: "none" });

    const bad = await service.start("alice");
    expect(bad.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    await expect(service.complete("alice", bad.loginId, "wrong")).rejects.toMatchObject({ code: "login_failed" });
    expect((await service.view("alice")).connected).toBe(false);

    const good = await service.start("alice");
    expect((await service.view("alice")).pending?.loginId).toBe(good.loginId);
    await expect(service.start("bob")).rejects.toMatchObject({ code: "login_busy" });
    const connected = await service.complete("alice", good.loginId, "good-code");
    expect(connected).toMatchObject({ connected: true, email: "user1@example.com", using: "claude-account" });
    expect(connected.pending).toBeUndefined();

    const endpoint = await service.endpointFor("alice", "claude-opus-5-5");
    expect(endpoint?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const models = await fetch(`${endpoint!.baseURL}/models`, { headers: { authorization: `Bearer ${endpoint!.authToken}` } });
    expect(models.status).toBe(200);
    expect(await service.endpointFor("alice", "claude-not-a-model")).toBeUndefined();
    expect(await service.endpointFor("bob", "claude-opus-5-5")).toBeUndefined();

    expect(await service.disconnect("alice")).toMatchObject({ connected: false });
    expect(await service.endpointFor("alice", "claude-opus-5-5")).toBeUndefined();
  }, 60_000);
});

describe("pickLoginCredential", () => {
  const entry = (id: number, identityKey: string | null) => ({ id, provider: "anthropic", identityKey, credential: {} });

  it("binds the row the login created, never another user's account", () => {
    const entries = [entry(1, "email:a"), entry(2, "email:b"), entry(3, "email:c")];
    expect(pickLoginCredential(entries, new Set([1, 2]), new Set([1]))?.id).toBe(3);
    expect(pickLoginCredential(entries, new Set([1, 2, 3]), new Set([1, 3]), 2)?.id).toBe(2);
    expect(pickLoginCredential(entries, new Set([1, 2, 3]), new Set([1]))).toBeUndefined();
    expect(pickLoginCredential([entry(4, null)], new Set(), new Set())).toBeUndefined();
  });
});

describe("ompEnvironment", () => {
  it("isolates oh-my-pi from the operator's own config and provider keys", () => {
    const env = ompEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", OMP_AUTH_BROKER_URL: "x", PI_CODING_AGENT_DIR: "/root/.omp", HOME: "/home/op" }, "/data/claude");
    expect(env).toEqual({ PATH: "/bin", HOME: "/data/claude" });
  });
});
