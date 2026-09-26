import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor, BenchRunResult } from "@vibread/core";
import { createAiToolset, invokeTool } from "@vibread/tools";
import { isStepCount, streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";
import { scriptedModel } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OPERATOR: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const CLAUDE_CODE: Actor = { kind: "agent", id: "claude-code", name: "Claude Code", channel: "mcp" };

interface BenchRequest {
  id: string;
  action: string;
  status: "pending" | "approved";
  revision: number | null;
  requestedBy: Actor;
  preApprovedBy?: Actor;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Audit R2-1: agent bench requests must reach the bench. Real server (SQLite broker, REST routes), both tool paths:
 * MCP/A2A (`invokeTool`) and the AI SDK agent loop (`createAiToolset` + streamText with a scripted model).
 */
describe("bench requests from agents reach the bench", () => {
  let running: RunningServer;
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-agents-bench-${randomBytes(6).toString("hex")}`,
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
      VIBREAD_OMP_BIN: "omp-not-installed",
    });
    process.env.LOG_LEVEL ??= "silent";
    process.env.VIBREAD_NO_STATIC = "1";
    running = await startServer(config);
    base = `http://127.0.0.1:${port}`;
  }, 60_000);
  afterAll(async () => {
    await running?.close();
  });

  /** A mission with revision 1; `released` makes it the build target (what the bench flashes and tests). */
  async function missionWithRevision(options: { released?: boolean } = { released: true }): Promise<string> {
    const { ctx } = running.context;
    const mission = await ctx.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OPERATOR });
    const revision = await ctx.store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author: OPERATOR });
    await ctx.store.updateMission(mission.id, { currentRevision: revision.n, ...(options.released ? { releasedRevision: revision.n } : {}) });
    return mission.id;
  }

  /** A passing virtual self-test on revision n (ServerCore requires one on the released revision before flash-app). */
  async function passSelftest(missionId: string, n: number): Promise<void> {
    const { ctx } = running.context;
    const pass: BenchRunResult = {
      runId: `pass-${n}`,
      revision: n,
      kind: "selftest",
      results: [],
      diagnosis: { attribution: "none", candidates: [], summary: "All bench checks passed." },
      calibration: [],
      verdict: "pass",
    };
    await ctx.store.saveResults(missionId, n, { bench: [pass] });
  }

  async function listed(missionId: string): Promise<BenchRequest[]> {
    const response = await fetch(`${base}/api/missions/${missionId}/bench/requests`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { requests: BenchRequest[] }).requests;
  }

  it("an MCP request_bench_action is listed with its bench action; a repeat dedupes; iMessage pre-approves; web start consumes once", async () => {
    const { ctx } = running.context;
    const missionId = await missionWithRevision();
    const call = () => invokeTool({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: CLAUDE_CODE }, name: "request_bench_action", args: { action: "flash-app" } });

    const first = await call();
    expect(first.status).toBe("bench-click");
    const again = await call();
    expect(again.status === "bench-click" && again.approval?.id).toBe(first.status === "bench-click" && first.approval?.id);

    const requests = await listed(missionId);
    expect(requests.map((r) => [r.action, r.status, r.revision, r.requestedBy.id])).toEqual([["flash-app", "pending", 1, "claude-code"]]);
    const id = requests[0]!.id;

    // A linked iMessage handle says GO: pre-approval only, nothing runs.
    const view = await ctx.missions.decide(id, "approve-once", { kind: "human", id: "operator", channel: "imessage" });
    expect(view.status).toBe("approved");
    const preApproved = await listed(missionId);
    expect(preApproved.map((r) => [r.action, r.status, r.preApprovedBy?.channel])).toEqual([["flash-app", "approved", "imessage"]]);

    // flash-app needs a passing self-test on the released revision first (server rule); then the bench click runs it once.
    const early = await fetch(`${base}/api/missions/${missionId}/bench/requests/${id}/start`, { method: "POST" });
    expect(early.status).toBe(409);
    await passSelftest(missionId, 1);
    const start = await fetch(`${base}/api/missions/${missionId}/bench/requests/${id}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ id, action: "flash-app", revision: 1 });
    const second = await fetch(`${base}/api/missions/${missionId}/bench/requests/${id}/start`, { method: "POST" });
    expect(second.status).toBe(409);
    expect(await listed(missionId)).toEqual([]);
    expect((await ctx.broker.get(id))?.status).toBe("consumed");
  });

  it("the design agent's request_bench_action (AI SDK loop) is listed for the bench and never executed", async () => {
    const { ctx } = running.context;
    const missionId = await missionWithRevision();
    const agent: Actor = { kind: "agent", id: "design-agent", name: "Design agent", channel: "web" };
    const toolset = createAiToolset({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: agent } });
    const result = streamText({
      model: scriptedModel([{ toolCalls: [{ name: "request_bench_action", input: { action: "run-selftest", note: "Check the LEDs" } }] }, { text: "Click Start at the bench." }]),
      prompt: "Run the self-test.",
      tools: toolset.tools,
      toolApproval: toolset.toolApproval,
      stopWhen: isStepCount(3),
    });
    const outputs: unknown[] = [];
    for await (const part of result.fullStream) if (part.type === "tool-result") outputs.push(part.output);
    expect(outputs).toEqual([expect.objectContaining({ action: "run-selftest", status: "waiting-for-bench-click", revision: 1, approvalId: expect.any(String) })]);

    const requests = await listed(missionId);
    expect(requests.map((r) => [r.action, r.status, r.requestedBy.id])).toEqual([["run-selftest", "pending", "design-agent"]]);
    expect(requests[0]!.id).toBe((outputs[0] as { approvalId: string }).approvalId);
  });

  it("a request for a revision the bench doesn't run is refused instead of silently vanishing", async () => {
    const { ctx } = running.context;
    const missionId = await missionWithRevision();
    await expect(
      invokeTool({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: CLAUDE_CODE }, name: "request_bench_action", args: { action: "flash-app", revision: 7 } }),
    ).rejects.toThrow("The bench runs the released revision (1), not revision 7.");
    expect(await listed(missionId)).toEqual([]);
  });

  it("audit R3-1: after a newer design is proposed, a bench request is bound to the RELEASED revision and runs that one", async () => {
    const { ctx } = running.context;
    const missionId = await missionWithRevision(); // r1 released
    // A newer design version appears (as over MCP): r2 is current, r1 stays the build target.
    const r2 = await ctx.store.createRevision(missionId, { circuit: { ...golden.circuit, title: "Moon-Phase Lamp v2" }, suite: golden.suite, author: CLAUDE_CODE, parent: 1 });
    await ctx.store.updateMission(missionId, { currentRevision: r2.n });
    const r1 = (await ctx.store.getRevision(missionId, 1))!;

    const result = await invokeTool({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: CLAUDE_CODE }, name: "request_bench_action", args: { action: "flash-app" } });
    expect(result.status).toBe("bench-click");
    const approval = result.status === "bench-click" ? result.approval! : undefined;
    expect([approval?.action, approval?.revisionHash]).toEqual(["flash-app", r1.hash]);
    expect(result.status === "bench-click" && (result.output as { revision: number }).revision).toBe(1);

    const requests = await listed(missionId);
    expect(requests.map((r) => [r.action, r.revision])).toEqual([["flash-app", 1]]);
    await passSelftest(missionId, 1); // "after a virtual pass on r1"
    const start = await fetch(`${base}/api/missions/${missionId}/bench/requests/${requests[0]!.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ action: "flash-app", revision: 1 });
    // Asking for the unreleased r2 explicitly is refused, naming the released one.
    await expect(
      invokeTool({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: CLAUDE_CODE }, name: "request_bench_action", args: { action: "flash-app", revision: 2 } }),
    ).rejects.toThrow("The bench runs the released revision (1), not revision 2.");
  });

  it("with nothing released, a bench request is refused and nothing is listed", async () => {
    const { ctx } = running.context;
    const missionId = await missionWithRevision({ released: false });
    await expect(
      invokeTool({ registry: ctx.tools, broker: ctx.broker, store: ctx.store, ctx: { missionId, actor: CLAUDE_CODE }, name: "request_bench_action", args: { action: "run-selftest" } }),
    ).rejects.toThrow("Nothing is released for the bench yet — press GO for build first.");
    expect(await listed(missionId)).toEqual([]);
    expect(await ctx.broker.listPending(missionId)).toEqual([]);
  });
});
