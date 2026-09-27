import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GOLDEN } from "@vibread/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";
import { eq } from "drizzle-orm";
import { apiTokens } from "../db/schema.js";

/**
 * An external agent driving ViBread over MCP on the real server (SQLite stores, tool registry, bench broker), with a
 * token minted the way Settings → Connect Claude Code does. No Claude account is connected: the agent calls the tools.
 */

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
let running: RunningServer;
let base: string;
let token: string;

async function connect(bearer: string): Promise<McpClient> {
  const client = new McpClient({ name: "vitest-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return client;
}

function text(result: object): string {
  const parts = "content" in result && Array.isArray(result.content) ? (result.content as { text?: string }[]) : [];
  return parts.map((part) => part.text ?? "").join("\n");
}

async function rawMcp(body: string, headers: Record<string, string>): Promise<{ status: number; json: { jsonrpc?: string; id?: unknown; error?: { code: number; message: string } } }> {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
  return { status: response.status, json: (await response.json()) as { jsonrpc?: string; error?: { code: number; message: string } } };
}

beforeAll(async () => {
  process.env.LOG_LEVEL ??= "silent";
  process.env.VIBREAD_NO_STATIC = "1";
  process.env.VIBREAD_LAN_PAIRING = "off";
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  running = await startServer(
    loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-mcp-test-${randomBytes(6).toString("hex")}`,
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
    }),
  );
  base = `http://127.0.0.1:${port}`;
  const minted = await fetch(`${base}/api/connections/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopes: ["circuits:read", "circuits:write", "bench:request"], ttlMinutes: 30 }),
  });
  expect(minted.status).toBe(201);
  token = ((await minted.json()) as { token: string }).token;
}, 60_000);

afterAll(async () => {
  await running?.close();
});

describe("MCP on the real server", () => {
  it("an agent creates a mission, proposes the moon-phase lamp, reads layout and steps, and can only request bench actions", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toMatch(/GO for build .*human-only/);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["vibread_create_mission", "propose_design", "layout_board", "build_steps", "request_bench_action"]));
    // GO for build is human-only: no MCP tool releases a revision.
    expect(names.filter((name) => /release|go_for_build/i.test(name))).toEqual([]);

    const unknownPart = await client.callTool({ name: "vibread_create_mission", arguments: { brief: golden.brief, inventory: [{ module: "flux-capacitor", count: 1 }] } });
    expect(unknownPart.isError).toBe(true);
    expect(text(unknownPart)).toContain("inventory[0].module");

    const created = await client.callTool({ name: "vibread_create_mission", arguments: { brief: golden.brief, inventory: golden.inventory } });
    expect(created.isError).not.toBe(true);
    const missionId = (JSON.parse(text(created)) as { id: string }).id;

    const proposed = await client.callTool({ name: "propose_design", arguments: { missionId, circuit: golden.circuit } }, undefined, { timeout: 120_000 });
    expect(proposed.isError).not.toBe(true);
    const outcome = JSON.parse(text(proposed)) as { accepted: boolean; revision: number; verdicts: Record<string, string>; findings: { ruleId: string; fix?: string }[] };
    expect(outcome).toMatchObject({ accepted: true, revision: 1, verdicts: { EECOM: "GO", GUIDO: "GO", FAO: "GO", FIDO: "NO-GO" } });
    // No Claude connected here: the test writer can't run, and an external agent must not be sent to retry forever.
    const notWritten = outcome.findings.find((finding) => finding.ruleId === "TESTS-NOT-WRITTEN");
    expect(notWritten?.fix).toContain("connect Claude");
    expect(notWritten?.fix).not.toContain("Propose the same design again");

    const lvs = JSON.parse(text(await client.callTool({ name: "lvs_check", arguments: { missionId } }))) as { ok: boolean };
    expect(lvs.ok).toBe(true);
    const steps = JSON.parse(text(await client.callTool({ name: "build_steps", arguments: { missionId } }))) as { steps: unknown[] };
    expect(steps.steps.length).toBeGreaterThan(5);

    // Nothing is released (only a person can press GO), so a bench request is refused and says what has to happen first.
    const bench = await client.callTool({ name: "request_bench_action", arguments: { missionId, action: "flash-bench" } });
    expect(bench.isError).toBe(true);
    expect(text(bench)).toMatch(/GO for build/);
    await client.close();
  }, 180_000);

  it("another user's mission reads exactly like a missing one", async () => {
    const own = await connect(token);
    const missionId = (JSON.parse(text(await own.callTool({ name: "vibread_create_mission", arguments: { brief: "A night light" } }))) as { id: string }).id;
    await own.close();
    const other = await running.context.ctx.tokens.mint({ userId: "mallory", scopes: ["circuits:read", "circuits:write", "bench:request"], ttlMinutes: 5 });
    const client = await connect(other.token);
    const foreign = await client.callTool({ name: "run_erc", arguments: { missionId } });
    const missing = await client.callTool({ name: "run_erc", arguments: { missionId: "no-such-mission" } });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toBe(text(missing).replace("no-such-mission", missionId));
    expect((await client.callTool({ name: "vibread_status", arguments: { missionId } })).isError).toBe(true);
    await client.close();
  });

  it("rejects bad tokens, foreign sessions, bad JSON, and oversized bodies with JSON-RPC errors", async () => {
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    const expired = await running.context.ctx.tokens.mint({ userId: "operator", scopes: ["circuits:read"], ttlMinutes: 1 });
    await running.context.ctx.db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.id, expired.id));
    for (const authorization of [`Bearer ${expired.token}`, "Bearer vb_forged", "Bearer not-a-vibread-token", ""]) {
      const { status, json } = await rawMcp(initialize, authorization ? { authorization } : {});
      expect(status).toBe(401);
      expect(json).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, message: expect.stringContaining("Connect Claude Code") } });
    }

    const client = await connect(token);
    const other = await running.context.ctx.tokens.mint({ userId: "mallory", scopes: ["circuits:read", "circuits:write", "bench:request"], ttlMinutes: 5 });
    const transport = client.transport as StreamableHTTPClientTransport;
    const hijack = await rawMcp(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), { authorization: `Bearer ${other.token}`, "mcp-session-id": transport.sessionId ?? "" });
    expect(hijack.status).toBe(404);
    expect(hijack.json).toMatchObject({ jsonrpc: "2.0", id: 2, error: { code: -32001 } });
    await client.close();

    const malformed = await rawMcp("{not json", { authorization: `Bearer ${token}` });
    expect(malformed).toMatchObject({ status: 400, json: { jsonrpc: "2.0", error: { code: -32700 } } });
    const huge = await rawMcp(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { pad: "x".repeat(3_000_000) } }), { authorization: `Bearer ${token}` });
    expect(huge).toMatchObject({ status: 413, json: { jsonrpc: "2.0", error: { code: -32600 } } });
  });

  it("caps free text at the web composer's limit", async () => {
    const client = await connect(token);
    const result = await client.callTool({ name: "vibread_create_mission", arguments: { brief: "a".repeat(4001) } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("brief");
    await client.close();
  });
});
