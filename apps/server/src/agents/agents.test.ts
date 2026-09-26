import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor, ConsoleReport, MissionStore } from "@vibread/core";
import type { Pipeline } from "@vibread/tools";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { UIMessage } from "ai";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "./index.js";
import { anthropicModels, type ClaudeModel } from "./models.js";
import { MAX_DESIGN_ITERATIONS } from "./runs.js";
import { mockModels, scriptedDesign, scriptedJson, testDeps, type ScriptStep } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const HUMAN: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const GO_VOTE = { verdict: "GO", summary: "The lamp does what the brief asks.", reasons: ["Debounced button", "Hysteresis on the light threshold"], concerns: [] };
/** No golden sketch (the mission's or the few-shot example's) may reach the test author. */
const SKETCH_MARKERS = ["void loop", "void setup", "pinMode(", "#define", ...GOLDEN.map((g) => g.circuit.sketch.source.slice(0, 80))];

type Chunk = { type: string; [key: string]: unknown };

/** Deterministic stand-in for the engine pipeline: every deterministic console GO. Counts evaluations. */
function goPipeline(store: MissionStore): Pipeline & { calls: number } {
  const pipeline = {
    calls: 0,
    async evaluate(missionId: string, n: number) {
      pipeline.calls++;
      const revision = (await store.getRevision(missionId, n))!;
      const reports: ConsoleReport[] = (["EECOM", "GUIDO", "FIDO", "FAO"] as const).map((console) => ({
        console,
        verdict: "GO",
        summary: "ok",
        findings: [],
        revisionHash: revision.hash,
        at: new Date().toISOString(),
      }));
      return (await store.saveResults(missionId, n, { reports })).results;
    },
  };
  return pipeline;
}

const proposeGolden: ScriptStep = { toolCalls: [{ name: "propose_design", input: { circuit: golden.circuit, note: "First design" } }] };

/**
 * A hand-driven design model for stop/error paths: streams "Thinking", then either waits for the abort signal or fails
 * with `failure` (what pi-ai's Anthropic stream reports on an HTTP error).
 */
function streamingDesign(failure?: string): ClaudeModel {
  const { model } = scriptedDesign([]);
  const streamFn: StreamFn = (m, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    partial.content = [{ type: "text", text: "Thinking" }];
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Thinking", partial });
    const end = (reason: "aborted" | "error", errorMessage: string) => stream.push({ type: "error", reason, error: { ...partial, stopReason: reason, errorMessage } });
    if (failure) end("error", failure);
    else options?.signal?.addEventListener("abort", () => end("aborted", "Request was aborted"));
    return stream;
  };
  const complete = () => Promise.reject(new Error("streamingDesign only drives the design agent"));
  return { model, modelId: model.id, credential: { kind: "server-key" }, streamFn, complete };
}

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
});

async function serve(runtime: AgentRuntime): Promise<string> {
  const app = express();
  app.use(express.json());
  // Stand-in for the server's session middleware: header x-test-user picks the signed-in user ("-" = signed out).
  app.use((req, res, next) => {
    const id = req.header("x-test-user") ?? "operator";
    if (id !== "-") res.locals.user = { id, name: id === "operator" ? "Operator" : id };
    next();
  });
  runtime.mountChat(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function sse(response: Response): Promise<Chunk[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

async function say(base: string, missionId: string, text: string): Promise<Chunk[]> {
  const response = await fetch(`${base}/api/missions/${missionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] } }),
  });
  expect(response.status).toBe(200);
  return sse(response);
}

async function setup(script: ScriptStep[], options: { realPipeline?: boolean } = {}) {
  const deps = testDeps();
  const fast = scriptedJson((context) => (JSON.stringify(context.messages).includes("RETRO") ? GO_VOTE : golden.suite));
  const pipeline = options.realPipeline ? undefined : goPipeline(deps.store);
  const design = scriptedDesign(script);
  const runtime = createAgentRuntime({ ...deps, models: mockModels(design, fast), ...(pipeline ? { pipeline } : {}) });
  const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
  const base = await serve(runtime);
  return { deps, fast, design, pipeline, runtime, mission, base };
}

describe("design agent", () => {
  it("proposes the golden lamp, runs the real pipeline, and records every console", async () => {
    const { deps, fast, runtime, mission, base } = await setup([proposeGolden, { text: "Revision 1 is ready." }], { realPipeline: true });
    const chunks = await say(base, mission.id, golden.brief);

    const output = chunks.find((c) => c.type === "tool-output-available")?.output as { accepted: boolean; revision: number; verdicts: Record<string, string> };
    expect(output.accepted).toBe(true);
    expect(output.revision).toBe(1);
    const revision = (await deps.store.getRevision(mission.id, 1))!;
    expect(revision.suite?.author).toBe("test-author");
    expect(revision.results.reports.map((r) => r.console)).toEqual(["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"]);
    // Real engines: electrical checks, compile + pin modes, and the independent suite all pass for the golden design.
    expect(output.verdicts).toMatchObject({ EECOM: "GO", GUIDO: "GO", FIDO: "GO" });
    expect(revision.results.artifacts["app.hex"]).toMatch(/^[0-9a-f]{64}$/);
    expect(revision.results.sim?.scenarios.every((s) => s.ok && s.traceKey?.startsWith("trace-"))).toBe(true);
    expect(deps.machine.events.map((e) => e.event.type)).toContain("DESIGN_READY");
    // The test author ran exactly once and never saw the sketch.
    expect(fast.requests.length).toBeGreaterThanOrEqual(1);
    const authorPrompt = JSON.stringify(fast.requests[0]!.messages);
    for (const marker of SKETCH_MARKERS) expect(authorPrompt).not.toContain(marker);
    expect(authorPrompt).toContain(golden.circuit.intent[0]!.text);
    expect((await deps.messages.list(mission.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  }, 120_000);

  it("records the RETRO vote when every deterministic console is GO", async () => {
    const { deps, runtime, mission, base } = await setup([proposeGolden, { text: "Ready." }]);
    await say(base, mission.id, golden.brief);
    const retro = (await deps.store.getRevision(mission.id, 1))!.results.reports.find((r) => r.console === "RETRO")!;
    expect(retro.verdict).toBe("GO");
    expect(retro.evidence).toMatchObject({ vote: "GO", reasons: GO_VOTE.reasons });
    const events = await runtime.missions.events(mission.id);
    expect(events.some((e) => e.kind === "console.report" && (e.data as { console?: string }).console === "RETRO")).toBe(true);
  });

  it("design changes run without any approval, and the agent is never offered a release tool", async () => {
    const deps = testDeps();
    const design = scriptedDesign([proposeGolden, { text: "Revision 1 is GO — press GO for build when you're ready." }]);
    const fast = scriptedJson((context) => (JSON.stringify(context.messages).includes("RETRO") ? GO_VOTE : golden.suite));
    const pipeline = goPipeline(deps.store);
    const runtime = createAgentRuntime({ ...deps, models: mockModels(design, fast), pipeline });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
    const chunks = await say(await serve(runtime), mission.id, golden.brief);

    expect(chunks.some((c) => c.type === "tool-approval-request")).toBe(false);
    expect(chunks.find((c) => c.type === "tool-output-available")?.output).toMatchObject({ accepted: true, revision: 1 });
    expect(pipeline.calls).toBe(1);
    expect(deps.broker.all()).toEqual([]);
    const offered = getCurrentTools(design.requests[0]!.messages).map((t) => t.name);
    expect(offered).toContain("propose_design");
    expect(offered).not.toContain("release_revision");
    // Only the person releases: the agent's GO leaves the build target unset.
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
  });

  it("stop aborts the active run and ends its stream", async () => {
    const deps = testDeps();
    // A model that streams one text chunk, then waits until the run is aborted.
    const runtime = createAgentRuntime({ ...deps, models: mockModels(streamingDesign(), scriptedJson([])) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
    const base = await serve(runtime);
    const response = await fetch(`${base}/api/missions/${mission.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"start"');
    expect((await runtime.missions.detail(mission.id)).agentBusy).toBe(true);

    const stopped = await fetch(`${base}/api/missions/${mission.id}/chat/stop`, { method: "POST" });
    expect(await stopped.json()).toEqual({ ok: true });
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    expect(rest).toContain('"type":"abort"');
    expect((await runtime.missions.detail(mission.id)).agentBusy).toBe(false);
    expect((await deps.messages.list(mission.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("traces the run, every model call, and every tool call to the mission's debug log", async () => {
    const { deps, runtime, mission } = await setup([proposeGolden, { text: "Ready." }]);
    await runtime.missions.say(mission.id, golden.brief, HUMAN);
    const mine = deps.debug.entries.filter((e) => e.missionId === mission.id);
    const data = (area: string, match: (d: Record<string, unknown>) => boolean) =>
      mine.filter((e) => e.area === area && match((e.data ?? {}) as Record<string, unknown>)).map((e) => e.data as Record<string, unknown>);

    expect(data("agent", (d) => "actor" in d && !("outcome" in d))).toEqual([expect.objectContaining({ actor: { kind: "human", id: "operator", channel: "web" } })]);
    expect(data("agent", (d) => d.outcome !== undefined)).toEqual([
      expect.objectContaining({ outcome: "done", steps: 2, finish: "stop", toolCalls: ["propose_design"], usage: { input: expect.any(Number), output: expect.any(Number) } }),
    ]);
    // Two design-agent turns (tool call, then the reply) plus the independent test author and RETRO on the fast model.
    const models = data("model", () => true);
    expect(models.filter((d) => d.purpose === "design").map((d) => [d.model, d.credential, d.stop, d.toolCalls])).toEqual([
      ["mock-design", "server-key", "toolUse", ["propose_design"]],
      ["mock-design", "server-key", "stop", undefined],
    ]);
    expect(models.filter((d) => d.purpose === "design").every((d) => typeof (d.usage as { input?: unknown }).input === "number" && typeof d.ms === "number")).toBe(true);
    expect(models.map((d) => d.purpose)).toEqual(expect.arrayContaining(["test-author", "retro"]));
    expect(data("tool", (d) => d.tool === "propose_design")).toEqual([
      expect.objectContaining({ actionClass: "state-changing", actor: expect.objectContaining({ kind: "agent" }), result: expect.objectContaining({ revision: 1, allGo: true }) }),
    ]);
    expect(data("agent", (d) => d.step === "retro")).toEqual([expect.objectContaining({ verdict: "GO", revision: 1 })]);
    // Without VIBREAD_DEBUG=1 neither prompts nor full tool inputs are logged.
    expect(JSON.stringify(mine)).not.toContain(golden.circuit.sketch.source.slice(0, 80));
  });

  it("say() runs one turn to completion for non-streaming channels", async () => {
    const { runtime, mission, deps } = await setup([proposeGolden, { text: "All consoles are GO." }]);
    const imessage: Actor = { kind: "human", id: "operator", channel: "imessage" };
    const turn = await runtime.missions.say(mission.id, golden.brief, imessage);
    expect(turn.revision).toBe(1);
    expect(turn.text).toContain("All consoles are GO.");
    expect(turn.pendingApprovals).toEqual([]);
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
    const events = await runtime.missions.events(mission.id);
    expect(events.filter((e) => e.kind === "message").map((e) => e.channel)).toEqual(["imessage", "imessage"]);
  });

  it("surfaces a typed error when Claude is not connected", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: anthropicModels({ config: { model: "claude-opus-5-5", fastModel: "claude-sonnet-5" } }) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
    const base = await serve(runtime);
    const response = await fetch(`${base}/api/missions/${mission.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "claude_not_connected", message: expect.stringContaining("Claude is not connected") } });
    await expect(runtime.missions.say(mission.id, "hi", HUMAN)).rejects.toMatchObject({ code: "claude_not_connected" });
    expect(await deps.messages.list(mission.id)).toEqual([]);
  });

  it("every chat route requires the signed-in owner (multi-user)", async () => {
    const { deps, mission, base, runtime } = await setup([{ text: "should never run" }]);
    const body = JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } });
    const routes: [string, string, string?][] = [
      ["GET", "/chat"],
      ["POST", "/chat", body],
      ["GET", "/chat/stream"],
      ["POST", "/chat/stop"],
    ];
    for (const [user, status] of [["-", 401], ["someone-else", 404]] as const) {
      for (const [method, path, payload] of routes) {
        const response = await fetch(`${base}/api/missions/${mission.id}${path}`, {
          method,
          headers: { "content-type": "application/json", "x-test-user": user },
          ...(payload ? { body: payload } : {}),
        });
        expect([user, method, path, response.status]).toEqual([user, method, path, status]);
      }
    }
    expect(await deps.messages.list(mission.id)).toEqual([]);
    expect((await runtime.missions.detail(mission.id)).agentBusy).toBe(false);
    // The owner still gets through.
    expect((await fetch(`${base}/api/missions/${mission.id}/chat`)).status).toBe(200);
  });

  it("rejects client-authored assistant history", async () => {
    const { base, mission } = await setup([]);
    const response = await fetch(`${base}/api/missions/${mission.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "approved" }] } }),
    });
    expect(response.status).toBe(400);
  });
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const textOf = (chunks: Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const lastReply = async (deps: ReturnType<typeof testDeps>, missionId: string): Promise<UIMessage> =>
  (await deps.messages.list(missionId)).findLast((m) => m.role === "assistant")!;

describe("design agent on pi → chat contract", () => {
  it("streams text, tool input, and tool results as AI SDK chunks with plain tool names, and saves the reply", async () => {
    const { deps, mission, base } = await setup([{ text: "Designing the lamp now.", toolCalls: proposeGolden.toolCalls }, { text: "Revision 1 is ready." }]);
    const chunks = await say(base, mission.id, golden.brief);
    const types = chunks.map((c) => c.type);

    expect(types[0]).toBe("start");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(types.filter((t) => t === "start-step")).toHaveLength(2);
    const at = (type: string) => types.indexOf(type);
    expect(at("tool-input-start")).toBeLessThan(at("tool-input-available"));
    expect(at("tool-input-available")).toBeLessThan(at("tool-output-available"));
    expect(new Set(chunks.flatMap((c) => (typeof c.toolName === "string" ? [c.toolName] : [])))).toEqual(new Set(["propose_design"]));
    expect(chunks.find((c) => c.type === "tool-output-available")?.output).toMatchObject({ accepted: true, revision: 1 });
    expect(textOf(chunks)).toBe("Designing the lamp now.Revision 1 is ready.");

    const reply = await lastReply(deps, mission.id);
    expect(reply.parts.map((p) => p.type)).toEqual(["step-start", "text", "tool-propose_design", "step-start", "text"]);
    expect(reply.parts[2]).toMatchObject({ state: "output-available", input: { note: "First design" }, output: { accepted: true } });
  });

  it("ask_user shows the question (over-long choices shortened, never rejected), ends the run, and the answer resumes it", async () => {
    const choices = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}: ${"a very long description ".repeat(10)}`);
    const { deps, runtime, mission, base, design } = await setup([
      { toolCalls: [{ name: "ask_user", input: { question: "Which color should the lamp glow?", choices } }] },
      { text: "Blue it is — designing now." },
    ]);
    const first = await say(base, mission.id, golden.brief);

    expect(design.requests).toHaveLength(1);
    expect(first.some((c) => c.type === "error" || c.type === "tool-output-error")).toBe(false);
    expect(first.find((c) => c.type === "tool-input-available")).toMatchObject({ toolName: "ask_user", input: { question: "Which color should the lamp glow?", choices } });
    const output = first.find((c) => c.type === "tool-output-available")?.output as { question: string; choices: string[] };
    expect(output.question).toBe("Which color should the lamp glow?");
    expect(output.choices).toHaveLength(10);
    expect(output.choices.every((c) => c.length <= 160)).toBe(true);
    expect(first.at(-1)?.type).toBe("finish");
    expect((await lastReply(deps, mission.id)).parts.find((p) => p.type === "tool-ask_user")).toMatchObject({ state: "output-available" });
    expect(deps.machine.events.map((e) => e.event.type)).toContain("NEEDS_CLARIFICATION");
    expect((await runtime.missions.events(mission.id)).filter((e) => e.kind === "message").map((e) => e.text)).toContain("Which color should the lamp glow?");

    const second = await say(base, mission.id, "Blue");
    expect(textOf(second)).toBe("Blue it is — designing now.");
    // The next run replays the question and its result to the model, then the answer.
    const replay = design.requests[1]!.messages;
    expect(replay.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "user"]);
    expect(replay[2]).toMatchObject({ content: [{ type: "toolCall", name: "ask_user", arguments: { question: "Which color should the lamp glow?" } }] });
    expect(replay[3]).toMatchObject({ toolName: "ask_user", isError: false });
    expect(replay[4]).toMatchObject({ role: "user", content: "Blue" });
  });

  it("invalid tool arguments go back to the model as tool errors and the run continues", async () => {
    const { deps, mission, base, design } = await setup([
      { toolCalls: [{ name: "propose_design", input: { circuit: "not a circuit" } }] },
      { toolCalls: [{ name: "ask_user", input: {} }] },
      { text: "Let me fix the design." },
    ]);
    const chunks = await say(base, mission.id, golden.brief);

    const errors = chunks.filter((c) => c.type === "tool-output-error");
    expect(errors).toHaveLength(2);
    expect(errors.every((c) => typeof c.errorText === "string" && (c.errorText as string).length > 0)).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(design.requests).toHaveLength(3);
    expect(design.requests[1]!.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "propose_design", isError: true });
    expect(design.requests[2]!.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "ask_user", isError: true });
    const reply = await lastReply(deps, mission.id);
    expect(reply.parts.filter((p) => p.type.startsWith("tool-")).map((p) => (p as { state: string }).state)).toEqual(["output-error", "output-error"]);
    expect(textOf(chunks)).toBe("Let me fix the design.");
  });

  it(`blocks design attempt ${MAX_DESIGN_ITERATIONS + 1} in one turn and tells the model to report blockers`, async () => {
    const { mission, base, pipeline } = await setup([...Array.from({ length: MAX_DESIGN_ITERATIONS + 1 }, () => proposeGolden), { text: "Here is what still blocks." }]);
    const chunks = await say(base, mission.id, golden.brief);
    expect(chunks.filter((c) => c.type === "tool-output-available")).toHaveLength(MAX_DESIGN_ITERATIONS);
    expect(chunks.find((c) => c.type === "tool-output-error")?.errorText).toContain(`the limit is ${MAX_DESIGN_ITERATIONS}`);
    expect(pipeline!.calls).toBe(MAX_DESIGN_ITERATIONS);
  });

  it("a model failure ends the run with a readable error in the chat and the debug log", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: mockModels(streamingDesign("401 invalid bearer token"), scriptedJson([])) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
    const chunks = await say(await serve(runtime), mission.id, "hi");

    expect(chunks.find((c) => c.type === "error")).toEqual({ type: "error", errorText: "The agent hit an error: 401 invalid bearer token" });
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "error" });
    expect((await runtime.missions.detail(mission.id)).agentBusy).toBe(false);
    expect((await deps.messages.list(mission.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
    const logged = deps.debug.entries.filter((e) => e.missionId === mission.id);
    expect(logged.find((e) => e.area === "model")).toMatchObject({ level: "error", data: expect.objectContaining({ stop: "error", error: "401 invalid bearer token" }) });
    expect(logged.find((e) => e.area === "agent" && (e.data as { outcome?: string }).outcome)).toMatchObject({ level: "error", data: expect.objectContaining({ outcome: "error" }) });
  });

  it("a browser that reconnects replays the running turn from its start, then follows it live", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: mockModels(streamingDesign(), scriptedJson([])) });
    const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: HUMAN });
    const base = await serve(runtime);
    const post = await fetch(`${base}/api/missions/${mission.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    const reader = post.body!.getReader();
    let seen = "";
    while (!seen.includes("Thinking")) seen += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); // the tab closed
    expect((await runtime.missions.detail(mission.id)).agentBusy).toBe(true);

    const resumed = await fetch(`${base}/api/missions/${mission.id}/chat/stream`);
    expect(resumed.status).toBe(200);
    const replay = resumed.body!.getReader();
    let head = "";
    while (!head.includes("Thinking")) head += new TextDecoder().decode((await replay.read()).value);
    expect(head.indexOf('"type":"start"')).toBeLessThan(head.indexOf("Thinking"));
    await fetch(`${base}/api/missions/${mission.id}/chat/stop`, { method: "POST" });
    let rest = "";
    for (let chunk = await replay.read(); !chunk.done; chunk = await replay.read()) rest += new TextDecoder().decode(chunk.value);
    expect(rest).toContain('"type":"abort"');
    expect((await fetch(`${base}/api/missions/${mission.id}/chat/stream`)).status).toBe(204);
  });

  it("photos in a chat message reach the model as images; other attachments are refused", async () => {
    const { base, mission, design } = await setup([{ text: "I see your breadboard." }]);
    const post = (parts: unknown[]) =>
      fetch(`${base}/api/missions/${mission.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { id: `u-${parts.length}`, role: "user", parts } }),
      });
    expect((await post([{ type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }])).status).toBe(400);
    expect((await post([{ type: "file", mediaType: "image/png", url: "https://example.com/board.png" }])).status).toBe(400);

    const ok = await post([{ type: "text", text: "Is this right?" }, { type: "file", mediaType: "image/png", url: PNG, filename: "board.png" }]);
    expect(textOf(await sse(ok))).toBe("I see your breadboard.");
    expect(design.requests[0]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Is this right?" }, { type: "image", mimeType: "image/png", data: PNG.slice("data:image/png;base64,".length) }],
    });
  });
});
