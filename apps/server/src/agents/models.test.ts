import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor } from "@vibread/core";
import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels } from "./models.js";
import { fakeClaudeAccounts, testDeps } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OWNER: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const CONFIG = { model: "claude-opus-5-5", fastModel: "claude-sonnet-5" };

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; stream?: boolean };
}

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A local stand-in for the per-user auth gateway: speaks the Anthropic Messages API and records every request. */
async function gatewayStub(reply: string): Promise<{ baseURL: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Seen["body"];
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const usage = { input_tokens: 3, output_tokens: 4 };
      if (body.stream) {
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
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, server };
}

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
});

describe("per-mission Claude credential", () => {
  it("uses the owner's connected Claude account (gateway baseURL + Bearer token) ahead of the server key", async () => {
    const gateway = await gatewayStub("from your account");
    const accounts = fakeClaudeAccounts({ operator: { endpoint: { baseURL: gateway.baseURL, authToken: "gw-token" }, email: "flight@example.com" } });
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server" }, claudeAccounts: accounts });

    const resolved = await models.design("operator", { missionId: null, purpose: "design" });
    expect(resolved.credential).toEqual({ kind: "claude-account", email: "flight@example.com" });
    const { text } = await generateText({ model: resolved.model, prompt: "hi" });
    expect(text).toBe("from your account");
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0]!.path).toBe("/v1/messages");
    expect(gateway.seen[0]!.headers.authorization).toBe("Bearer gw-token");
    expect(gateway.seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(gateway.seen[0]!.body.model).toBe("claude-opus-5-5");
    expect(accounts.endpointCalls).toEqual([{ userId: "operator", model: "claude-opus-5-5" }]);
  });

  it("falls back to the server key when the owner has no usable account", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "server" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const accounts = fakeClaudeAccounts();
    const models = anthropicModels({ config: { ...CONFIG, anthropicApiKey: "sk-server" }, claudeAccounts: accounts, fetch: recordingFetch });

    const resolved = await models.fast("someone-else", { missionId: null, purpose: "retro" });
    expect(resolved.credential).toEqual({ kind: "server-key" });
    await generateText({ model: resolved.model, prompt: "hi" });
    expect(calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(calls[0]!.headers.get("x-api-key")).toBe("sk-server");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(accounts.endpointCalls).toEqual([{ userId: "someone-else", model: "claude-sonnet-5" }]);
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

  it("a design run on the owner's account streams through the gateway and says so on the timeline once", async () => {
    const gateway = await gatewayStub("Hi! What should your lamp do?");
    const deps = testDeps();
    const accounts = fakeClaudeAccounts({ operator: { endpoint: { baseURL: gateway.baseURL, authToken: "gw-token" }, email: "flight@example.com" } });
    const runtime = createAgentRuntime({ ...deps, claudeAccounts: accounts, models: anthropicModels({ config: CONFIG, claudeAccounts: accounts }) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OWNER });

    const turn = await runtime.missions.say(mission.id, "hello", OWNER);
    expect(turn.text).toBe("Hi! What should your lamp do?");
    expect(gateway.seen.map((s) => [s.path, s.headers.authorization, s.body.stream])).toEqual([["/v1/messages", "Bearer gw-token", true]]);
    const credentialEvents = (await runtime.missions.events(mission.id)).filter((e) => e.kind === "agent.credential");
    expect(credentialEvents.map((e) => e.text)).toEqual(["Using your Claude account (flight@example.com)"]);
  });
});
