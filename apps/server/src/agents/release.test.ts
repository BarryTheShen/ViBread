import { GOLDEN } from "@vibread/fixtures";
import type { Actor, ConsoleReport, MissionStore, Verdict } from "@vibread/core";
import type { Pipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels, type AgentModels } from "./models.js";
import { mockModels, scriptedDesign, scriptedJson, testDeps, type ScriptedModel } from "./testing.js";

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
  const fast = scriptedJson((context) => (JSON.stringify(context.messages).includes("You are RETRO") ? (input.vote ?? GO_VOTE) : golden.suite));
  const models = input.models ?? mockModels(scriptedDesign([]), fast);
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

const authorCalls = (fast: ScriptedModel) => fast.requests.filter((c) => JSON.stringify(c.messages).includes("independent test author")).length;

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
  it("web override releases a missing-test revision as-is and records every bypassed gate without changing verdicts", async () => {
    const { deps, runtime, mission } = await setup({ withSuite: false, models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    const before = await deps.store.getRevision(mission.id, 1);
    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, override: { reason: "tested by hand" } });
    expect(detail.mission.releasedRevision).toBe(1);
    const released = await deps.store.getRevision(mission.id, 1);
    expect(released?.suite).toBeUndefined();
    expect(released?.results.reports.map((report) => [report.console, report.verdict])).toEqual(before?.results.reports.map((report) => [report.console, report.verdict]));
    const event = (await runtime.missions.events(mission.id)).find((candidate) => candidate.kind === "release.override");
    expect(event?.text).toContain("Simulation tests (FIDO) not written");
    expect(event?.text).toContain("independent review not run");
    expect(event?.text).toContain("Reason: tested by hand");
    expect(event?.data).toMatchObject({ bypassed: expect.arrayContaining(["Simulation tests (FIDO) not written", "independent review not run"]), reason: "tested by hand" });
  });

  it("override includes failing simulation scenarios and permits a NO-GO review, but agents and iMessage cannot use it", async () => {
    const { deps, runtime, mission } = await setup({});
    const revision = (await deps.store.getRevision(mission.id, 1))!;
    const reports = revision.results.reports.map((report) => report.console === "FIDO" ? {
      ...report,
      verdict: "NO-GO" as const,
      findings: [
        { console: "FIDO" as const, ruleId: "SIM-FAIL", severity: "error" as const, title: "T1 fails", refs: { scenarios: ["T1"] } },
        { console: "FIDO" as const, ruleId: "TEST-SET-ASIDE", severity: "warning" as const, title: "T2 set aside", refs: { scenarios: ["T2"] } },
      ],
    } : report.console === "RETRO" ? report : report);
    await deps.store.saveResults(mission.id, 1, {
      reports: [
        ...reports,
        { console: "RETRO", verdict: "NO-GO", summary: "Review found a concern", findings: [], revisionHash: revision.hash, at: new Date().toISOString() },
      ],
    });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: { kind: "agent", id: "a", channel: "mcp" }, override: {} })).rejects.toMatchObject({ status: 403, code: "override_not_allowed" });
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: { kind: "human", id: "operator", channel: "imessage" }, override: {} })).rejects.toMatchObject({ status: 403, code: "override_not_allowed" });
    const detail = await runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, override: {} });
    expect(detail.mission.releasedRevision).toBe(1);
    const event = (await runtime.missions.events(mission.id)).find((candidate) => candidate.kind === "release.override");
    expect(event?.text).toContain("Simulation tests (FIDO) NO-GO");
    expect(event?.text).toContain("failed scenarios: T1; set-aside tests (warnings only): T2");
    expect(event?.text).toContain("Independent review (RETRO) NO-GO");
    expect((await deps.store.getRevision(mission.id, 1))?.results.reports.find((report) => report.console === "FIDO")?.verdict).toBe("NO-GO");
  });
  it("rejects an override reason longer than 200 characters", async () => {
    const { runtime, mission } = await setup({});
    await expect(runtime.release({ missionId: mission.id, revision: 1, actor: FLIGHT, override: { reason: "x".repeat(201) } })).rejects.toMatchObject({ status: 400, code: "invalid_override" });
  });
});
