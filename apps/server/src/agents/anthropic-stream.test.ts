import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor } from "@vibread/core";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels } from "./models.js";
import { testDeps } from "./testing.js";

/**
 * The design agent against real-shaped Anthropic Messages streams (what api.anthropic.com sends, through pi-ai's own
 * Anthropic client): thinking with signatures, several tool_use blocks in one message, fine-grained input_json_delta,
 * max_tokens, refusals, rate limits and overload. Only the HTTP endpoint is local.
 */

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const HUMAN: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
type Chunk = { type: string; [key: string]: unknown };
type Reply = { status?: number; headers?: Record<string, string>; body?: unknown; events?: object[] };
type Request = { model: string; messages: { role: string; content: unknown }[]; tools?: { name: string }[]; thinking?: unknown; betas?: string[]; beta: string };
type Replies = Reply[] | ((request: Request, index: number) => Reply);

const usage = { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage } };
const end = (stop: string) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 120 } },
  { type: "message_stop" },
];
const text = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...value.match(/[\s\S]{1,7}/g)!.map((piece) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } })),
  { type: "content_block_stop", index },
];
const thinking = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: value } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "EqQBCkYIBxgCKkDsig==" } },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, id: string, name: string, input: object) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  ...(JSON.stringify(input).match(/[\s\S]{1,5}/g) ?? []).map((piece) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } })),
  { type: "content_block_stop", index },
];

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
});

/** Local Anthropic endpoint: answers each POST /v1/messages with the next reply and records the request bodies. */
async function anthropic(replies: Replies): Promise<{ origin: string; requests: Request[] }> {
  const requests: Request[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request: Request = { ...JSON.parse(raw), beta: String(req.headers["anthropic-beta"] ?? "") };
      requests.push(request);
      const reply = typeof replies === "function" ? replies(request, requests.length - 1) : replies[Math.min(requests.length - 1, replies.length - 1)]!;
      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply.events!.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function run(replies: Replies, config: { model?: string; claudeProtocol?: "managed" | "plain" } = {}) {
  const claude = await anthropic(replies);
  const deps = testDeps();
  const models = anthropicModels({
    config: { model: config.model ?? "claude-opus-5-5", fastModel: "claude-sonnet-5", anthropicApiKey: "sk-ant-api03-test", anthropicBaseUrl: claude.origin, ...(config.claudeProtocol ? { claudeProtocol: config.claudeProtocol } : {}) },
    onProtocolFallback: (modelId, error) => deps.debug.event(null, "model", `${modelId}: retried plain`, { model: modelId, error }, "warn"),
  });
  const runtime = createAgentRuntime({ ...deps, models });
  const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.user = { id: "operator", name: "Operator" };
    next();
  });
  runtime.mountChat(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions/${mission.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: golden.brief }] } }),
  });
  const chunks = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
  return { chunks, claude, history: await deps.messages.list(mission.id), runtime, mission, deps };
}

const said = (chunks: Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");

describe("design agent on real-shaped Anthropic streams", () => {
  it("thinking + two tool calls in one message stream correctly, and the signed thinking goes back to Claude in the same turn", async () => {
    const { chunks, claude, history } = await run([
      { events: [start, ...thinking(0, "Check parts and modules first."), ...text(1, "Checking."), ...toolUse(2, "toolu_a", "get_inventory", {}), ...toolUse(3, "toolu_b", "list_modules", {}), ...end("tool_use")] },
      { events: [start, ...thinking(0, "All set."), ...text(1, "Your parts are ready."), ...end("end_turn")] },
    ]);
    expect(chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.delta)).toEqual(["Check parts and modules first.", "All set."]);
    expect(chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolName)).toEqual(["get_inventory", "list_modules"]);
    expect(chunks.filter((c) => c.type === "tool-output-available")).toHaveLength(2);
    expect(said(chunks)).toBe("Checking.Your parts are ready.");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    // Second request: the assistant turn is replayed with its signed thinking, then both tool results.
    const replay = claude.requests[1]!.messages.filter((m) => m.role !== "system");
    expect(replay.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(replay[1]!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "thinking", signature: "EqQBCkYIBxgCKkDsig==" }), expect.objectContaining({ type: "tool_use", id: "toolu_a" }), expect.objectContaining({ type: "tool_use", id: "toolu_b" })]));
    expect((replay[2]!.content as { type: string; tool_use_id: string }[]).map((c) => [c.type, c.tool_use_id])).toEqual([["tool_result", "toolu_a"], ["tool_result", "toolu_b"]]);
    expect(history.at(-1)!.parts.map((p) => p.type)).toEqual(["step-start", "reasoning", "text", "tool-get_inventory", "tool-list_modules", "step-start", "reasoning", "text"]);
  });

  it("a reply cut off at max_tokens is kept and the person is told it was cut off", async () => {
    const { chunks, history } = await run([{ events: [start, ...text(0, "Here is the long expla"), ...end("max_tokens")] }]);
    expect(said(chunks)).toContain("Here is the long expla");
    expect(said(chunks)).toContain("cut off at Claude's output limit");
    expect(JSON.stringify(history.at(-1))).toContain("cut off");
  });

  it("a refusal ends the run with a plain message", async () => {
    const { chunks } = await run([{ events: [start, ...text(0, "I can't"), ...end("refusal")] }]);
    expect(chunks.find((c) => c.type === "error")?.errorText).toBe("Claude declined to answer this request. Rephrase it and send it again.");
  });

  it("an overload error in the middle of the stream ends the run with a plain message", async () => {
    const { chunks, history } = await run([{ events: [start, ...text(0, "Designing"), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }] }]);
    expect(chunks.find((c) => c.type === "error")?.errorText).toBe("Claude is overloaded right now. Try again in a minute.");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("rate limits are retried as Claude asks (retry-after), then reported plainly", async () => {
    const limited: Reply = { status: 429, headers: { "retry-after-ms": "5", "retry-after": "0" }, body: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } } };
    const { chunks, claude } = await run([limited]);
    expect(claude.requests.length).toBeGreaterThan(1);
    expect(chunks.find((c) => c.type === "error")?.errorText).toBe("Claude is busy right now (rate limit). Wait a minute, then send your message again.");
  });

  it("a tool call whose input fails the tool's schema goes back to Claude, and the run finishes", async () => {
    const { chunks, claude } = await run([
      { events: [start, ...toolUse(0, "toolu_bad", "propose_design", { circuit: { title: "no schema field" } }), ...end("tool_use")] },
      { events: [start, ...text(0, "I'll fix the design."), ...end("end_turn")] },
    ]);
    expect(chunks.find((c) => c.type === "tool-output-error")).toMatchObject({ toolCallId: "toolu_bad" });
    const result = (claude.requests[1]!.messages.at(-2) ?? claude.requests[1]!.messages.at(-1))!;
    expect(JSON.stringify(result)).toContain('"is_error":true');
    expect(said(chunks)).toBe("I'll fix the design.");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

});

/** What pi-ai's managed protocol puts in a request: 2026 betas, system-role messages, adaptive thinking, deferred tools. */
function managed(request: Request): Record<string, boolean> {
  return {
    betas: /mid-conversation|thinking-binding/.test(request.beta),
    systemMessages: request.messages.some((m) => m.role === "system"),
    adaptiveThinking: JSON.stringify(request.thinking ?? null).includes("block_binding"),
    placeholderTool: (request.tools ?? []).some((t) => t.name === "__pi_deferred_placeholder__"),
  };
}
const NONE = { betas: false, systemMessages: false, adaptiveThinking: false, placeholderTool: false };
const REFUSED_BETA: Reply = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Unexpected value(s) `mid-conversation-output-config-2026-07-01` for the `anthropic-beta` header." } } };

describe("pi-ai's managed request protocol for claude-opus-5-5", () => {
  it("a 400 refusing it is retried once without it, logged, and later requests go plain straight away", async () => {
    const { chunks, claude, deps } = await run((request, index) =>
      managed(request).betas ? REFUSED_BETA : index === 1 ? { events: [start, ...toolUse(0, "toolu_1", "list_modules", {}), ...end("tool_use")] } : { events: [start, ...text(0, "Done."), ...end("end_turn")] },
    );
    expect(managed(claude.requests[0]!)).toEqual({ betas: true, systemMessages: true, adaptiveThinking: true, placeholderTool: true });
    expect(claude.requests.slice(1).map(managed)).toEqual([NONE, NONE]);
    expect(claude.requests[1]!.tools!.map((t) => t.name)).toContain("propose_design");
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(said(chunks)).toBe("Done.");
    expect(deps.debug.entries.filter((e) => e.message.includes("retried plain"))).toEqual([
      expect.objectContaining({ level: "warn", data: expect.objectContaining({ model: "claude-opus-5-5", error: expect.stringContaining("anthropic-beta") }) }),
    ]);
  });

  it("other 400s are not retried", async () => {
    const tooLong: Reply = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" } } };
    const { chunks, claude } = await run([tooLong]);
    expect(claude.requests).toHaveLength(1);
    expect(chunks.find((c) => c.type === "error")?.errorText).toContain("prompt is too long");
  });

  it("VIBREAD_CLAUDE_PROTOCOL=plain never uses it", async () => {
    const { claude, chunks } = await run([{ events: [start, ...text(0, "Hi."), ...end("end_turn")] }], { claudeProtocol: "plain" });
    expect(claude.requests.map(managed)).toEqual([NONE]);
    expect(said(chunks)).toBe("Hi.");
  });

  it("VIBREAD_MODEL=claude-sonnet-5 runs the design agent without it", async () => {
    const { claude, chunks } = await run(
      [{ events: [start, ...toolUse(0, "toolu_1", "get_inventory", {}), ...end("tool_use")] }, { events: [start, ...text(0, "Ready."), ...end("end_turn")] }],
      { model: "claude-sonnet-5" },
    );
    expect(claude.requests.map((r) => r.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5"]);
    expect(claude.requests.map(managed)).toEqual([NONE, NONE]);
    expect(claude.requests[0]!.thinking).toEqual({ type: "disabled" });
    expect(said(chunks)).toBe("Ready.");
  });
});
