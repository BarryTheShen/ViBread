import { GOLDEN } from "@vibread/fixtures";
import type { Actor, ConsoleReport, MissionStore, Verdict } from "@vibread/core";
import type { Pipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels, type AgentModels } from "./models.js";
import { jsonModel, mockModels, scriptedModel, testDeps } from "./testing.js";

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
        verdict: console === "FAO" ? fao : console === "FIDO" && !revision.suite ? "PENDING" : "GO",
        summary: "fixed",
        findings: [],
        revisionHash: revision.hash,
        at: new Date().toISOString(),
      }));
      return (await store.saveResults(missionId, n, { reports })).results;
    },
  };
}

async function setup(input: { models?: AgentModels; fao?: Verdict; vote?: object; withSuite?: boolean }) {
  const deps = testDeps();
  const pipeline = fixedPipeline(deps.store, input.fao);
  // The fast model answers as RETRO or as the independent test author, depending on the system prompt.
  const fast = jsonModel((call) => (JSON.stringify(call.prompt).includes("You are RETRO") ? (input.vote ?? GO_VOTE) : golden.suite));
  const models = input.models ?? mockModels(scriptedModel([]), fast);
  const runtime = createAgentRuntime({ ...deps, models, pipeline });
  const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: FLIGHT });
  // A pre-warmed revision (like scripts/seed-golden.ts): pipeline only, no RETRO vote yet.
  const revision = await deps.store.createRevision(mission.id, {
    circuit: golden.circuit,
    ...(input.withSuite === false ? {} : { suite: golden.suite }),
    author: { kind: "system", id: "golden", channel: "system" },
  });
  await deps.store.updateMission(mission.id, { currentRevision: revision.n });
  await pipeline.evaluate(mission.id, revision.n);
  return { deps, runtime, mission, fast };
}

const authorCalls = (fast: ReturnType<typeof jsonModel>) => fast.doGenerateCalls.filter((c) => JSON.stringify(c.prompt).includes("independent test author")).length;

describe("human release (GO for build)", () => {
  it("releases a GO revision, runs RETRO first when it never ran, and sends RELEASED", async () => {
    const { deps, runtime, mission } = await setup({});
    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect(detail.mission.releasedRevision).toBe(1);
    expect(detail.released?.verdicts.RETRO).toBe("GO");
    expect(deps.machine.events.map((e) => e.event)).toContainEqual({ type: "RELEASED", revision: 1 });
    // Releasing is the person's own action: no approval request is involved.
    expect(deps.broker.all()).toEqual([]);
    const events = await runtime.missions.events(mission.id);
    expect(events.find((e) => e.kind === "revision.released")?.actor).toEqual(FLIGHT);
    expect(events.some((e) => e.kind === "release.review-waived")).toBe(false);
  });

  it("blocks a revision whose deterministic consoles are not all GO", async () => {
    const { deps, runtime, mission } = await setup({ fao: "NO-GO" });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true })).rejects.toMatchObject({
      status: 409,
      code: "not_all_go",
      message: expect.stringContaining("Assembly (FAO) NO-GO"),
    });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
    expect(deps.broker.all()).toEqual([]);
  });

  it("a RETRO NO-GO vote blocks even with the acknowledgement", async () => {
    const { deps, runtime, mission } = await setup({ vote: NO_GO_VOTE });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true })).rejects.toMatchObject({ status: 409, code: "retro_no_go" });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
  });

  it("without Claude, release needs an explicit acknowledgement and records it on the timeline", async () => {
    const { deps, runtime, mission } = await setup({ models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT })).rejects.toMatchObject({ status: 409, code: "retro_missing" });
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();

    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true });
    expect(detail.mission.releasedRevision).toBe(1);
    const waived = (await runtime.missions.events(mission.id)).filter((e) => e.kind === "release.review-waived");
    expect(waived.map((e) => e.text)).toEqual(["Released by Operator without the independent review — Claude isn't connected."]);
  });

  it("releasing the already released revision is a no-op", async () => {
    const { runtime, mission } = await setup({});
    await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect((await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT })).mission.releasedRevision).toBe(1);
    expect((await runtime.missions.events(mission.id)).filter((e) => e.kind === "revision.released")).toHaveLength(1);
  });

  it("a revision saved without tests gets them written, recorded as revision n+1, and that revision is released", async () => {
    const { deps, runtime, mission, fast } = await setup({ withSuite: false });
    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect(detail.mission.releasedRevision).toBe(2);
    const recorded = (await deps.store.getRevision(mission.id, 2))!;
    expect(recorded.parent).toBe(1);
    expect(recorded.circuit).toEqual((await deps.store.getRevision(mission.id, 1))!.circuit);
    expect(recorded.suite?.author).toBe("test-author");
    expect(recorded.results.reports.map((r) => [r.console, r.verdict])).toEqual([["EECOM", "GO"], ["GUIDO", "GO"], ["FIDO", "GO"], ["FAO", "GO"], ["RETRO", "GO"]]);
    expect(authorCalls(fast)).toBe(1);
    expect(deps.machine.events.map((e) => e.event)).toContainEqual({ type: "RELEASED", revision: 2 });
  });

  it("without a credential, a revision without tests can't be released (plain message), and nothing is recorded", async () => {
    const { deps, runtime, mission } = await setup({ withSuite: false, models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, acknowledgeMissingReview: true })).rejects.toMatchObject({
      status: 409,
      code: "tests_missing",
      message:
        "The simulation tests haven't been written yet because Claude isn't connected — connect your Claude account in Settings (or set ANTHROPIC_API_KEY), then press GO for build again.",
    });
    expect(await deps.store.listRevisions(mission.id)).toHaveLength(1);
    expect((await deps.store.getMission(mission.id))?.releasedRevision).toBeUndefined();
  });

  it("run_scenarios writes missing tests and runs them; the later release reuses the same suite", async () => {
    const { deps, runtime, mission, fast } = await setup({ withSuite: false });
    const runScenarios = runtime.tools.get("run_scenarios")!;
    const output = (await runScenarios.handler({ missionId: mission.id, actor: FLIGHT }, { revision: 1 })) as {
      testsWrittenNow?: boolean;
      scenarios: { ok: boolean }[];
      coverage: { ok: boolean };
    };
    expect(output.testsWrittenNow).toBe(true);
    expect(output.scenarios.length).toBe(golden.suite.scenarios.length);
    expect(output.scenarios.every((s) => s.ok)).toBe(true);
    expect(output.coverage.ok).toBe(true);
    expect(await deps.store.listRevisions(mission.id)).toHaveLength(1); // read-only: nothing recorded yet

    await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT });
    expect(authorCalls(fast)).toBe(1); // cached: the author is not paid twice
    expect((await deps.store.getRevision(mission.id, 2))!.suite).toEqual({ ...golden.suite, author: "test-author" });
  }, 60_000);

  it("run_scenarios without a credential says the tests haven't been written", async () => {
    const { runtime, mission } = await setup({ withSuite: false, models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    await expect(runtime.tools.get("run_scenarios")!.handler({ missionId: mission.id, actor: FLIGHT }, { revision: 1 })).rejects.toThrow(
      "The simulation tests haven't been written yet because Claude isn't connected",
    );
  });
});
