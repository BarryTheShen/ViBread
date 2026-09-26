import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor } from "@vibread/core";
import { normalizeContext, type Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels, type ClaudeModel } from "./models.js";
import { fakeClaudeAccounts, testDeps } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OWNER: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const CONFIG = { model: "claude-opus-5-5", fastModel: "claude-sonnet-5" };
const HOUR = 3_600_000;
const SIGN_IN: Credential = { type: "oauth", access: "sk-ant-oat01-owner", refresh: "sk-ant-ort01-owner", expires: Date.now() + HOUR };

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; stream?: boolean };
}

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A local stand-in for the Anthropic API (ANTHROPIC_BASE_URL): speaks the Messages API and records every request. */
async function anthropicStub(reply: string): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Seen["body"];
      seen.push({ path: new URL(req.url ?? "", "http://stub").pathname, headers: req.headers, body });
      const usage = { input_tokens: 3, output_tokens: 4 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse([
          { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ]),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function say(claude: ClaudeModel): Promise<string> {
  const stream = await claude.streamFn(claude.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }));
  const reply = await stream.result();
  return reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || `${reply.stopReason}: ${reply.errorMessage}`;
}

let servers: Server[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
});

describe("per-mission Claude credential", () => {
  it("uses the owner's Claude sign-in (OAuth bearer with Claude's own client identity) ahead of the server key", async () => {
    const stub = await anthropicStub("from your account");
    const accounts = fakeClaudeAccounts({ operator: { credential: SIGN_IN, email: "flight@example.com" } });
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server", anthropicBaseUrl: stub.origin }, claudeAccounts: accounts });

    const claude = await models.design("operator", { missionId: null, purpose: "design" });
    expect(claude.credential).toEqual({ kind: "claude-account", email: "flight@example.com" });
    expect(await say(claude)).toBe("from your account");
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]!.path).toBe("/v1/messages");
    expect(stub.seen[0]!.headers.authorization).toBe("Bearer sk-ant-oat01-owner");
    expect(stub.seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(stub.seen[0]!.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(stub.seen[0]!.body.model).toBe("claude-opus-5-5");
  });

  it("uses the owner's own API key when they connected one", async () => {
    const stub = await anthropicStub("from your key");
    const accounts = fakeClaudeAccounts({ operator: { credential: { type: "api_key", key: "sk-ant-owner-key" } } });
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server", anthropicBaseUrl: stub.origin }, claudeAccounts: accounts });

    const claude = await models.fast("operator", { missionId: null, purpose: "retro" });
    expect(claude.credential.kind).toBe("claude-account");
    expect(await say(claude)).toBe("from your key");
    expect(stub.seen[0]!.headers["x-api-key"]).toBe("sk-ant-owner-key");
    expect(stub.seen[0]!.body.model).toBe("claude-sonnet-5");
  });

  it("falls back to the server key when the owner has no credential", async () => {
    const stub = await anthropicStub("server");
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server", anthropicBaseUrl: stub.origin }, claudeAccounts: fakeClaudeAccounts() });

    const claude = await models.fast("someone-else", { missionId: null, purpose: "retro" });
    expect(claude.credential).toEqual({ kind: "server-key" });
    expect(await say(claude)).toBe("server");
    expect(stub.seen[0]!.headers["x-api-key"]).toBe("sk-server");
    expect(stub.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("an owner's expired sign-in that can't be refreshed falls back to the server key instead of failing the run", async () => {
    const stub = await anthropicStub("server");
    const realFetch = globalThis.fetch;
    const refreshes: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/oauth/token")) {
        refreshes.push(url);
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return realFetch(input, init);
    });
    const expired: Credential = { ...SIGN_IN, expires: Date.now() - HOUR };
    const log = { warn: vi.fn() };
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server", anthropicBaseUrl: stub.origin }, claudeAccounts: fakeClaudeAccounts({ operator: { credential: expired } }), log });

    const claude = await models.design("operator", { missionId: null, purpose: "design" });
    expect(refreshes).toHaveLength(1);
    expect(claude.credential).toEqual({ kind: "server-key" });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(await say(claude)).toBe("server");
  });

  it("with neither, chat answers 503 claude_not_connected", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: anthropicModels({ config: CONFIG, claudeAccounts: deps.claudeAccounts }) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OWNER });
    await expect(runtime.missions.say(mission.id, "hi", OWNER)).rejects.toMatchObject({
      code: "claude_not_connected",
      status: 503,
      message: "Claude is not connected: connect your Claude account in Settings, or set ANTHROPIC_API_KEY on the server.",
    });
  });

  it("a design run on the owner's account goes out with their credential and says so on the timeline once", async () => {
    const stub = await anthropicStub("Hi! What should your lamp do?");
    const deps = testDeps();
    const accounts = fakeClaudeAccounts({ operator: { credential: SIGN_IN, email: "flight@example.com" } });
    const runtime = createAgentRuntime({ ...deps, claudeAccounts: accounts, models: anthropicModels({ config: { ...CONFIG, anthropicBaseUrl: stub.origin }, claudeAccounts: accounts }) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OWNER });

    const turn = await runtime.missions.say(mission.id, "hello", OWNER);
    expect(turn.text).toBe("Hi! What should your lamp do?");
    expect(stub.seen.map((s) => [s.path, s.headers.authorization, s.body.stream])).toEqual([["/v1/messages", "Bearer sk-ant-oat01-owner", true]]);
    const credentialEvents = (await runtime.missions.events(mission.id)).filter((e) => e.kind === "agent.credential");
    expect(credentialEvents.map((e) => e.text)).toEqual(["Using your Claude account (flight@example.com)"]);
  });
});
