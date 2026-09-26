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
async function anthropic(replies: Reply[]): Promise<{ origin: string; requests: { messages: { role: string; content: unknown }[] }[] }> {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
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

async function run(replies: Reply[]) {
  const claude = await anthropic(replies);
  const deps = testDeps();
  const runtime = createAgentRuntime({ ...deps, models: anthropicModels({ config: { model: "claude-opus-5-5", fastModel: "claude-sonnet-5", anthropicApiKey: "sk-ant-api03-test", anthropicBaseUrl: claude.origin } }) });
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
  return { chunks, claude, history: await deps.messages.list(mission.id), runtime, mission };
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
