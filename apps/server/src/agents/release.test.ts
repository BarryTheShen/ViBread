import { GOLDEN } from "@vibread/fixtures";
import type { Actor, ConsoleReport, MissionStore, PermissionMode, Verdict } from "@vibread/core";
import type { Pipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels, type AgentModels } from "./models.js";
import { jsonModel, mockModels, scriptedModel, testDeps, type ScriptStep } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const FLIGHT: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const GO_VOTE = { verdict: "GO", summary: "Matches the brief.", reasons: ["ok"], concerns: [] };
const NO_GO_VOTE = { verdict: "NO-GO", summary: "The button isn't debounced.", reasons: ["bounce"], concerns: [] };

/** Deterministic consoles with fixed verdicts (FAO overridable) — no engines needed to test the release rules. */
function fixedPipeline(store: MissionStore, fao: Verdict = "GO"): Pipeline {
  return {
    async evaluate(missionId, n) {
      const revision = (await store.getRevision(missionId, n))!;
      const reports: ConsoleReport[] = (["EECOM", "GUIDO", "FIDO", "FAO"] as const).map((console) => ({
        console,
        verdict: console === "FAO" ? fao : "GO",
        summary: "fixed",
        findings: [],
        revisionHash: revision.hash,
        at: new Date().toISOString(),
      }));
      return (await store.saveResults(missionId, n, { reports })).results;
    },
  };
}

async function setup(input: { mode: PermissionMode; models?: AgentModels; fao?: Verdict; vote?: object; script?: ScriptStep[] }) {
  const deps = testDeps();
  const pipeline = fixedPipeline(deps.store, input.fao);
  const models = input.models ?? mockModels(scriptedModel(input.script ?? []), jsonModel([input.vote ?? GO_VOTE]));
  const runtime = createAgentRuntime({ ...deps, models, pipeline });
  const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, mode: input.mode, owner: FLIGHT });
  // A pre-warmed revision (like scripts/seed-golden.ts): pipeline only, no RETRO vote yet.
  const revision = await deps.store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author: { kind: "system", id: "golden", channel: "system" } });
  await deps.store.updateMission(mission.id, { currentRevision: revision.n });
  await pipeline.evaluate(mission.id, revision.n);
  return { deps, runtime, mission };
}

describe("human release (GO for build)", () => {
  it("releases a GO revision, runs RETRO first when it never ran, and sends RELEASED", async () => {
    const { deps, runtime, mission } = await setup({ mode: "review" });
    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect(detail.mission.releasedRevision).toBe(1);
    expect(detail.released?.verdicts.RETRO).toBe("GO");
    expect(deps.machine.events.map((e) => e.event)).toContainEqual({ type: "RELEASED", revision: 1 });
    expect(deps.broker.all().map((r) => [r.action, r.status, r.decidedBy?.id])).toEqual([["release_revision", "consumed", "operator"]]);
    const events = await runtime.missions.events(mission.id);
    expect(events.find((e) => e.kind === "revision.released")?.actor).toEqual(FLIGHT);
    expect(events.some((e) => e.kind === "release.review-waived")).toBe(false);
  });

  it("blocks a revision whose deterministic consoles are not all GO", async () => {
    const { deps, runtime, mission } = await setup({ mode: "review", fao: "NO-GO" });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true })).rejects.toMatchObject({
      status: 409,
      code: "not_all_go",
      message: expect.stringContaining("Assembly (FAO) NO-GO"),
    });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
    expect(deps.broker.all()).toEqual([]);
  });

  it("a RETRO NO-GO vote blocks even with the acknowledgement", async () => {
    const { deps, runtime, mission } = await setup({ mode: "review", vote: NO_GO_VOTE });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true })).rejects.toMatchObject({ status: 409, code: "retro_no_go" });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
  });

  it("without Claude, release needs an explicit acknowledgement and records it on the timeline", async () => {
    const { deps, runtime, mission } = await setup({ mode: "review", models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT })).rejects.toMatchObject({ status: 409, code: "retro_missing" });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();

    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true });
    expect(detail.mission.releasedRevision).toBe(1);
    const waived = (await runtime.missions.events(mission.id)).filter((e) => e.kind === "release.review-waived");
    expect(waived.map((e) => e.text)).toEqual(["Released by Operator without the independent review — Claude isn't connected."]);
  });

  it("Plan mode gates the agent, not the human", async () => {
    const { runtime, mission } = await setup({ mode: "plan" });
    expect((await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT })).mission.releasedRevision).toBe(1);
  });

  it("approves the agent's pending release card instead of creating a second approval, executing exactly once", async () => {
    const { deps, runtime, mission } = await setup({
      mode: "review",
      script: [{ toolCalls: [{ name: "release_revision", input: { revision: 1 } }] }, { text: "Released — time to build." }],
    });
    const turn = await runtime.missions.say(mission.id, "Looks good, release it.", FLIGHT);
    expect(turn.pendingApprovals.map((a) => a.action)).toEqual(["release_revision"]);

    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect(detail.mission.releasedRevision).toBe(1);
    expect(detail.pendingApprovals).toEqual([]);
    expect(deps.broker.all().map((r) => r.status)).toEqual(["consumed"]);
    const events = await runtime.missions.events(mission.id);
    expect(events.filter((e) => e.kind === "revision.released")).toHaveLength(1);
    // The agent's card was answered by the click and the agent resumed: its tool call completed.
    const history = await deps.messages.list(mission.id);
    const part = history.flatMap((m) => m.parts).find((p) => p.type === "tool-release_revision") as { state: string };
    expect(part.state).toBe("output-available");
    expect(history.at(-1)!.parts.some((p) => p.type === "text" && p.text === "Released — time to build.")).toBe(true);
  });
});
