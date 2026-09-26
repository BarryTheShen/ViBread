import { GOLDEN } from "@vibread/fixtures";
import type { Actor } from "@vibread/core";
import { createToolRegistry, invokeTool, type Pipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { memoryBroker, memoryStore } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const CLAUDE_CODE: Actor = { kind: "agent", id: "claude-code", name: "Claude Code", channel: "mcp" };
const HUMAN: Actor = { kind: "human", id: "operator", channel: "web" };

async function setup() {
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
  const mission = await store.createMission({ title: "t", brief: golden.brief, ownerId: "o", inventory: golden.inventory });
  const call = (name: string, args: unknown) => invokeTool({ registry, broker, store, ctx: { missionId: mission.id, actor: CLAUDE_CODE }, name, args });
  return { store, broker, registry, mission, call, evaluations: () => evaluations };
}

describe("tool registry (MCP/A2A path, no permission modes)", () => {
  it("tags every tool with its action class, and has no release tool", async () => {
    const { registry } = await setup();
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
      request_bench_action: "physical",
      add_part: "bom-change",
    });
    // Releasing (GO for build) is only the person's action.
    expect(registry.get("release_revision")).toBeUndefined();
  });

  it("design changes run directly: propose_design saves and evaluates a revision without any approval", async () => {
    const { call, broker, store, mission, evaluations } = await setup();
    expect(await call("propose_design", { circuit: golden.circuit, note: "v1" })).toMatchObject({ status: "executed", output: { accepted: true, revision: 1 } });
    expect(await call("propose_design", { circuit: golden.circuit, note: "v2" })).toMatchObject({ status: "executed", output: { revision: 2 } });
    expect((await store.listRevisions(mission.id)).length).toBe(2);
    expect(evaluations()).toBe(2);
    expect(broker.all()).toEqual([]);
  });

  it("add_part runs directly and says when the part isn't in the user's inventory", async () => {
    const { call, store, mission, broker } = await setup();
    const missing = await call("add_part", { module: "buzzer-active", count: 1, note: "launch beep" });
    expect(missing).toMatchObject({ status: "executed", output: { inInventory: false, summary: "Added 1× Buzzer (active) — not in your inventory; make sure you have one" } });
    const owned = await call("add_part", { module: "led", count: 1, params: { color: golden.inventory.find((i) => i.module === "led")?.params?.color } });
    expect(owned).toMatchObject({ status: "executed", output: { inInventory: true } });
    expect((await store.getMission(mission.id))!.inventory.at(-1)).toMatchObject({ module: "led", count: 1 });
    expect(broker.all()).toEqual([]);
  });

  it("physical actions only become bench requests, bound to the released revision", async () => {
    const { call, store, mission } = await setup();
    const revision = await store.createRevision(mission.id, { circuit: golden.circuit, author: HUMAN });
    await store.updateMission(mission.id, { currentRevision: revision.n, releasedRevision: revision.n });
    const result = await call("request_bench_action", { action: "flash-app" });
    expect(result.status).toBe("bench-click");
    expect(result.status === "bench-click" && [result.approval.action, result.approval.revisionHash, result.approval.status]).toEqual(["flash-app", revision.hash, "pending"]);
  });
});
