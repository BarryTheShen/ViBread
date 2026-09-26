import { GOLDEN } from "@vibread/fixtures";
import type { Actor, PermissionMode } from "@vibread/core";
import { createToolRegistry, invokeTool, type Pipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { memoryBroker, memoryStore } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const CLAUDE_CODE: Actor = { kind: "agent", id: "claude-code", name: "Claude Code", channel: "mcp" };
const HUMAN: Actor = { kind: "human", id: "operator", channel: "web" };

async function setup(mode: PermissionMode) {
  const store = memoryStore();
  const broker = memoryBroker();
  let evaluations = 0;
  const pipeline: Pipeline = {
    async evaluate(missionId, n) {
      evaluations++;
      return (await store.saveResults(missionId, n, { reports: [] })).results;
    },
  };
  const registry = createToolRegistry({ store, pipeline });
  const mission = await store.createMission({ title: "t", brief: golden.brief, ownerId: "o", inventory: golden.inventory, mode });
  const call = (name: string, args: unknown, approvalId?: string) =>
    invokeTool({ registry, broker, store, ctx: { missionId: mission.id, actor: CLAUDE_CODE }, name, args, ...(approvalId ? { approvalId } : {}) });
  return { store, broker, registry, mission, call, evaluations: () => evaluations };
}

describe("tool registry policy (MCP/A2A path)", () => {
  it("tags every PLAN §5.2 tool with its action class", async () => {
    const { registry } = await setup("review");
    const classes = Object.fromEntries(registry.list().map((t) => [t.name, t.actionClass]));
    expect(classes).toMatchObject({
      list_modules: "read-only",
      get_inventory: "read-only",
      propose_design: "state-changing",
      validate_ir: "read-only",
      run_erc: "read-only",
      compile: "read-only",
      run_scenarios: "read-only",
      lvs_check: "read-only",
      diagnose: "read-only",
      release_revision: "release",
      request_bench_action: "physical",
      add_part: "bom-change",
    });
  });

  it("Plan mode denies state-changing tools and still runs read-only ones", async () => {
    const { call, store, mission, evaluations } = await setup("plan");
    expect(await call("validate_ir", { circuit: golden.circuit })).toMatchObject({ status: "executed", output: { ok: true } });
    expect(await call("propose_design", { circuit: golden.circuit })).toMatchObject({ status: "denied" });
    expect(await store.getRevision(mission.id)).toBeNull();
    expect(evaluations()).toBe(0);
  });

  it("Ask mode needs a human; the approval executes once and only for the same input", async () => {
    const { call, broker, store, mission } = await setup("ask");
    const first = await call("propose_design", { circuit: golden.circuit, note: "v1" });
    expect(first.status).toBe("approval-required");
    const approval = first.status === "approval-required" ? first.approval : undefined;
    await expect(broker.decide(approval!.id, "approve-once", CLAUDE_CODE)).rejects.toThrow();

    await broker.decide(approval!.id, "approve-once", HUMAN);
    expect(await call("propose_design", { circuit: golden.circuit, note: "different" }, approval!.id)).toMatchObject({ status: "denied" });
    expect(await call("propose_design", { circuit: golden.circuit, note: "v1" }, approval!.id)).toMatchObject({ status: "executed", output: { accepted: true, revision: 1 } });
    expect(await call("propose_design", { circuit: golden.circuit, note: "v1" }, approval!.id)).toMatchObject({ status: "denied" });
    expect((await store.listRevisions(mission.id)).length).toBe(1);
  });

  it("physical actions only become bench-click requests", async () => {
    const { call, store, mission } = await setup("autopilot");
    await store.createRevision(mission.id, { circuit: golden.circuit, author: HUMAN });
    const result = await call("request_bench_action", { action: "flash-app" });
    expect(result.status).toBe("bench-click");
  });

  it("release needs every console GO", async () => {
    const { call, store, mission } = await setup("autopilot");
    await store.createRevision(mission.id, { circuit: golden.circuit, author: HUMAN });
    const result = await call("release_revision", { revision: 1 });
    // No reports → not all GO → a human must approve even in Autopilot.
    expect(result.status).toBe("approval-required");
  });
});
