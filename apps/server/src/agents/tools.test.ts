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

  it("an identical approved, unused action is consumed exactly once without a new request; a denied one can be re-requested", async () => {
    const { call, broker, store, mission } = await setup("ask");
    const args = { circuit: golden.circuit, note: "v1" };
    const first = await call("propose_design", args);
    const approval = first.status === "approval-required" ? first.approval : undefined;
    await broker.decide(approval!.id, "approve-once", HUMAN);
    // Retried without the approval id: the broker returns the approved request, the gate consumes it and executes.
    expect(await call("propose_design", args)).toMatchObject({ status: "executed", output: { revision: 1 } });
    expect(broker.all().map((r) => r.status)).toEqual(["consumed"]);
    // The next identical call (now on revision 1) needs a new approval; deny it, then retry: a fresh pending request.
    const second = await call("propose_design", args);
    expect(second.status).toBe("approval-required");
    const denied = second.status === "approval-required" ? second.approval : undefined;
    await broker.decide(denied!.id, "deny", HUMAN);
    const third = await call("propose_design", args);
    expect(third.status).toBe("approval-required");
    expect(third.status === "approval-required" && third.approval.id).not.toBe(denied!.id);
    expect(broker.all().map((r) => r.status)).toEqual(["consumed", "denied", "pending"]);
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

  it("add_part always needs a human and then extends the mission inventory", async () => {
    const { call, broker, store, mission } = await setup("autopilot");
    const args = { module: "buzzer-active", count: 1, note: "launch beep" };
    const asked = await call("add_part", args);
    expect(asked.status).toBe("approval-required");
    const approval = asked.status === "approval-required" ? asked.approval : undefined;
    await broker.decide(approval!.id, "approve-once", HUMAN);
    expect(await call("add_part", args, approval!.id)).toMatchObject({ status: "executed" });
    expect((await store.getMission(mission.id))!.inventory.at(-1)).toMatchObject({ module: "buzzer-active", count: 1 });
  });
});
