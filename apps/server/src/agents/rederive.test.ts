import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Actor, Layout, Revision, StepList } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { createPipeline } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { BUILD_PROGRESS_EVENT } from "../services/build-progress.js";
import { WIRE_COLOR_EVENT } from "../services/wire-colors.js";
import { createMissionStore } from "../store/missions.js";
import { createAgentRuntime } from "./index.js";
import { createDerivedRefresher } from "./rederive.js";
import { mockModels, scriptedDesign, scriptedJson, testDeps } from "./testing.js";

/**
 * Derived results made by older code are re-derived on start (issue #22 follow-up): only results change, never the design;
 * a build in progress keeps its placement and wire colours and gets its progress mapped onto the new steps.
 * Real pipeline (compile, simulator, layout, steps, pictures) on the golden launch control; the derivation versions are
 * stubbed ("old" = what an earlier release stamped, "new" = the running code).
 */

const golden = GOLDEN.find((g) => g.key === "launch-control")!;
const FLIGHT: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };

async function setup() {
  const deps = testDeps();
  const oldCode = createPipeline({ store: deps.store, faults: false, derivation: async () => "old" });
  const newCode = createPipeline({ store: deps.store, faults: false, derivation: async () => "new" });
  const calls: number[] = [];
  const counted = { evaluate: (missionId: string, n: number, options?: Parameters<typeof newCode.evaluate>[2]) => (calls.push(n), newCode.evaluate(missionId, n, options)) };
  const runtime = createAgentRuntime({ ...deps, models: mockModels(scriptedDesign([]), scriptedJson([])), pipeline: counted });
  const mission = await runtime.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: FLIGHT });
  const revision = await deps.store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author: { kind: "system", id: "golden", channel: "system" }, note: "Pre-warmed golden" });
  await deps.store.updateMission(mission.id, { currentRevision: revision.n });
  await oldCode.evaluate(mission.id, revision.n);
  const refresher = createDerivedRefresher({ store: deps.store, pipeline: runtime.pipeline, debug: deps.debug, log: deps.log, version: async () => "new", missionIds: async () => [mission.id] });
  return { deps, runtime, mission, refresher, calls };
}

const design = (r: Revision) => ({ circuit: r.circuit, suite: r.suite, author: r.author, note: r.note, hash: r.hash, createdAt: r.createdAt, parent: r.parent });

describe("derived results made by older code are refreshed on start", () => {
  it("re-derives an out-of-date current revision: results only, the design untouched, no timeline noise", async () => {
    const { deps, mission, refresher } = await setup();
    const before = (await deps.store.getRevision(mission.id, 1))!;
    const eventsBefore = (await deps.store.listEvents(mission.id)).length;
    expect(before.results.derivation).toBe("old");

    const summary = await refresher.run();

    expect(summary).toMatchObject({ version: "new", skipped: 0, failed: [], refreshed: [{ missionId: mission.id, revision: 1, keptLayout: false, verdictsChanged: false }] });
    const after = (await deps.store.getRevision(mission.id, 1))!;
    expect(after.results.derivation).toBe("new");
    expect(design(after)).toEqual(design(before));
    expect(after.results.steps?.steps.length).toBeGreaterThan(0);
    expect(after.results.artifacts["step-1.png"]).toBeDefined();
    // Same verdicts: no console.report spam and no re-check note.
    expect((await deps.store.listEvents(mission.id)).length).toBe(eventsBefore);
    expect(deps.debug.entries.filter((e) => e.missionId === null && e.message.includes("re-derived revision 1"))).toHaveLength(1);
  }, 180_000);

  it("leaves a revision derived by the running code alone", async () => {
    const { deps, mission, refresher, calls } = await setup();
    await refresher.run();
    calls.length = 0;
    const again = await refresher.run();
    expect(again).toMatchObject({ refreshed: [], skipped: 1 });
    expect(calls).toEqual([]);
    expect((await deps.store.getRevision(mission.id, 1))!.results.derivation).toBe("new");
  }, 180_000);

  it("a check the updated pipeline judges differently keeps the new verdict, with a timeline note", async () => {
    const { deps, mission, refresher } = await setup();
    // What older code said: assembly NO-GO (the updated layout code now gets this design right).
    const stored = (await deps.store.getRevision(mission.id, 1))!;
    await deps.store.saveResults(mission.id, 1, { reports: stored.results.reports.map((r) => (r.console === "FAO" ? { ...r, verdict: "NO-GO" as const } : r)) });

    const summary = await refresher.run();

    expect(summary.refreshed[0]).toMatchObject({ verdictsChanged: true });
    expect((await deps.store.getRevision(mission.id, 1))!.results.reports.find((r) => r.console === "FAO")?.verdict).toBe("GO");
    const note = (await deps.store.listEvents(mission.id)).find((e) => e.kind === "revision.rechecked");
    expect(note?.text).toBe("Re-checked revision 1 with the updated pipeline: Assembly NO-GO → GO.");
  }, 180_000);

  it("a build in progress keeps its placement and wire colours, gets new steps from that placement, and its progress mapped", async () => {
    const { deps, runtime, mission, refresher } = await setup();
    const lib = await import("@vibread/assembly");
    const stored = (await deps.store.getRevision(mission.id, 1))!;
    // The placement on the builder's desk differs from what the updated allocator would make (two wires swap ids), so
    // keeping it is observable.
    const [first, second] = stored.results.layout!.jumpers;
    const desk: Layout = { ...stored.results.layout!, jumpers: stored.results.layout!.jumpers.map((j) => (j.id === first!.id ? { ...j, id: second!.id } : j.id === second!.id ? { ...j, id: first!.id } : j)) };
    // Older step code on that placement put two things on the board in one step where the new code uses two steps.
    const current = lib.buildSteps(golden.circuit, desk);
    const places = (s: StepList["steps"][number]) => s.adds.parts.length + s.adds.jumpers.length > 0;
    const k = current.steps.findIndex((s, i) => i > 0 && places(s) && current.steps[i + 1] !== undefined && places(current.steps[i + 1]!));
    expect(k).toBeGreaterThan(0);
    const [a, b] = [current.steps[k]!, current.steps[k + 1]!];
    const merged = { ...a, adds: { parts: [...a.adds.parts, ...b.adds.parts], jumpers: [...a.adds.jumpers, ...b.adds.jumpers] } };
    const oldSteps: StepList = { ...current, steps: [...current.steps.slice(0, k), merged, ...current.steps.slice(k + 2)].map((s, i) => ({ ...s, n: i + 1 })) };
    await deps.store.saveResults(mission.id, 1, { layout: desk, steps: oldSteps });
    await deps.store.updateMission(mission.id, { releasedRevision: 1 });
    // The builder finished the old steps up to the merged one (old step k+1) and recoloured a wire.
    const reached = k + 1;
    for (let n = 1; n <= reached; n++) await deps.store.appendEvent({ missionId: mission.id, channel: "web", actor: FLIGHT, kind: "build.step", text: `Step ${n} done`, revision: 1, data: { n } });
    await deps.store.appendEvent({ missionId: mission.id, channel: "web", actor: FLIGHT, kind: WIRE_COLOR_EVENT, text: `Wire ${first!.id} set to purple`, revision: 1, data: { key: `wire:${first!.id}`, color: "purple" } });
    expect((await runtime.missions.build(mission.id)).current).toBe(reached + 1);

    const summary = await refresher.run();

    const after = (await deps.store.getRevision(mission.id, 1))!;
    expect(summary.refreshed[0]).toMatchObject({ keptLayout: true, progress: { from: reached, to: k + 2 } });
    expect(after.results.layout).toEqual(desk);
    // New step text and pictures, derived by the running code from the kept placement.
    expect(after.results.steps).toEqual(lib.buildSteps(golden.circuit, desk));
    expect(design(after)).toEqual(design(stored));
    // Old steps 1…k+1 put on the board what new steps 1…k+2 do: the builder continues at new step k+3.
    const build = await runtime.missions.build(mission.id);
    expect(build.current).toBe(k + 3);
    expect(build.wires?.overrides).toEqual({ [`wire:${first!.id}`]: "purple" });
    const note = (await deps.store.listEvents(mission.id)).findLast((e) => e.kind === BUILD_PROGRESS_EVENT);
    expect(note?.text).toBe(`The build steps were updated (same placement, clearer steps). Your progress carries over: continue at step ${k + 3} of ${after.results.steps!.steps.length}.`);
    // Ticking off the next step still works on the new numbering.
    await deps.store.appendEvent({ missionId: mission.id, channel: "web", actor: FLIGHT, kind: "build.step", text: `Step ${k + 3} done`, revision: 1, data: { n: k + 3 } });
    expect((await runtime.missions.build(mission.id)).current).toBe(k + 4);
  }, 180_000);
});

describe("one unreadable mission doesn't stop the start-up refresh", () => {
  it("reports the missions whose stored JSON is corrupt and still refreshes every other mission", async () => {
    const dir = `/tmp/vb-vitest-${randomUUID()}`;
    const opened = openDatabase(dir);
    try {
      const deps = testDeps();
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const author: Actor = { kind: "system", id: "golden", channel: "system" };
      const ids: string[] = [];
      for (const title of ["Corrupt mission", "Corrupt revision", "Healthy"]) {
        const mission = await store.createMission({ title, brief: golden.brief, ownerId: "operator", inventory: golden.inventory });
        const revision = await store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author });
        await store.saveResults(mission.id, revision.n, { derivation: "old" });
        await store.updateMission(mission.id, { currentRevision: revision.n });
        ids.push(mission.id);
      }
      const [brokenMission, brokenRevision, healthy] = ids as [string, string, string];
      opened.sqlite.prepare('UPDATE "missions" SET "inventory" = ? WHERE "id" = ?').run("{not json", brokenMission);
      opened.sqlite.prepare('UPDATE "revisions" SET "results" = ? WHERE "missionId" = ?').run("{not json", brokenRevision);
      // Re-deriving only stamps the running version: this test is about which missions get re-derived, not how.
      const evaluated: string[] = [];
      const pipeline = { evaluate: async (missionId: string, n: number) => (evaluated.push(missionId), (await store.saveResults(missionId, n, { derivation: "new" })).results) };
      const refresher = createDerivedRefresher({ store, pipeline, debug: deps.debug, log: deps.log, version: async () => "new", missionIds: async () => ids });

      const summary = await refresher.run();

      expect(evaluated).toEqual([healthy]);
      expect(summary.refreshed).toMatchObject([{ missionId: healthy, revision: 1 }]);
      expect(summary.failed.map((f) => f.missionId)).toEqual([brokenMission, brokenRevision]);
      expect(summary.failed.every((f) => f.error.length > 0)).toBe(true);
      expect((await store.getRevision(healthy, 1))!.results.derivation).toBe("new");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
