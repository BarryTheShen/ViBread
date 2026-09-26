import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDatabase, type OpenDatabase } from "../db/index.js";
import { createClaudeAccountService, ompEnvironment, pickLoginCredential, type ClaudeAccountService } from "./accounts.js";

const fakeOmp = fileURLToPath(new URL("./fake-omp.mjs", import.meta.url));

describe("Claude account connection (oh-my-pi broker + gateway)", () => {
  let dir: string;
  let opened: OpenDatabase;
  let service: ClaudeAccountService;

  beforeAll(() => {
    chmodSync(fakeOmp, 0o755);
    dir = mkdtempSync(join(tmpdir(), "vb-claude-"));
    const config = loadConfig({ DATA_DIR: dir, PORT: "8999" });
    config.claudeAccounts = { ompBin: fakeOmp, home: join(dir, "claude-accounts") };
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

    const mismatch = await service.start("alice");
    const mismatchStarted = Date.now();
    await expect(service.complete("alice", mismatch.loginId, "http://localhost:54545/?code=wrong#state=other")).rejects.toMatchObject({ code: "login_state_mismatch" });
    expect(Date.now() - mismatchStarted).toBeLessThan(2_000);

    const bad = await service.start("alice");
    expect(bad.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    const badStarted = Date.now();
    await expect(service.complete("alice", bad.loginId, "http://localhost:54545/?code=wrong#state=abc")).rejects.toMatchObject({ code: "login_failed" });
    expect(Date.now() - badStarted).toBeLessThan(2_000);
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
    expect(pickLoginCredential([entry(4, "email:orphan")], new Set([4]), new Set())).toBeUndefined();
  });
});

describe("ompEnvironment", () => {
  it("keeps only safe runtime settings and isolates the operator's own config and provider keys", () => {
    const env = ompEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/op",
        TMPDIR: "/tmp",
        LANG: "C",
        LC_ALL: "C",
        TERM: "xterm",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        HTTP_PROXY: "http://proxy",
        https_proxy: "http://proxy-lower",
        NO_PROXY: "localhost",
        SYSTEMROOT: "C:\\Windows",
        ANTHROPIC_API_KEY: "sk",
        OMP_AUTH_BROKER_URL: "x",
        PI_CODING_AGENT_DIR: "/root/.omp",
        BETTER_AUTH_SECRET: "better",
        VIBREAD_MODEL: "model",
        VIBREAD_FOO: "secret",
        PHOTON_PROJECT_SECRET: "photon",
        GOOGLE_CLIENT_SECRET: "google",
        GITHUB_CLIENT_SECRET: "github",
      },
      "/data/claude",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/data/claude",
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      TERM: "xterm",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      HTTP_PROXY: "http://proxy",
      https_proxy: "http://proxy-lower",
      NO_PROXY: "localhost",
      SYSTEMROOT: "C:\\Windows",
    });
  });

  it("points the Windows profile directories into the isolated home, so omp never writes to the real profile", () => {
    const env = ompEnvironment({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op", APPDATA: "C:\\Users\\op\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local" }, "/data/claude");
    expect(env.HOME).toBe("/data/claude");
    expect(env.USERPROFILE).toBe("/data/claude");
    expect(env.APPDATA).toBe(join("/data/claude", "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(join("/data/claude", "AppData", "Local"));
  });
});
