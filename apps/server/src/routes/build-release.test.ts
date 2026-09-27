import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor, BuildState } from "@vibread/core";
import { buildSteps, layoutBoard } from "@vibread/assembly/layout";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";

const moon = GOLDEN.find((golden) => golden.key === "moon-phase-lamp")!;
const OPERATOR: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Build Mode must not let a builder follow (or tick off) steps for a design nobody pressed GO on. */
describe("build state before and after release", () => {
  let running: RunningServer;
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-build-release-${randomBytes(6).toString("hex")}`,
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
    });
    process.env.LOG_LEVEL ??= "silent";
    process.env.VIBREAD_NO_STATIC = "1";
    running = await startServer(config);
    base = `http://127.0.0.1:${port}`;
  }, 60_000);
  afterAll(async () => {
    await running?.close();
  });

  async function missionWithSteps(release: boolean): Promise<string> {
    const { ctx } = running.context;
    const mission = await ctx.missions.create({ brief: moon.brief, inventory: moon.inventory, owner: OPERATOR });
    const revision = await ctx.store.createRevision(mission.id, { circuit: moon.circuit, suite: moon.suite, author: OPERATOR });
    const layout = layoutBoard(moon.circuit);
    await ctx.store.saveResults(mission.id, revision.n, { layout, steps: buildSteps(moon.circuit, layout) });
    await ctx.store.updateMission(mission.id, { currentRevision: revision.n, ...(release ? { releasedRevision: revision.n } : {}) });
    return mission.id;
  }

  type Answer = BuildState & { released: boolean };
  const build = async (missionId: string) => (await (await fetch(`${base}/api/missions/${missionId}/build`)).json()) as Answer;
  const markStep = (missionId: string, n: number) =>
    fetch(`${base}/api/missions/${missionId}/build/step`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n }) });

  it("previews an unreleased design as released: false and refuses to record its steps", async () => {
    const missionId = await missionWithSteps(false);
    const preview = await build(missionId);
    expect(preview.released).toBe(false);
    expect(preview.steps.length).toBeGreaterThan(1);

    const refused = await markStep(missionId, 1);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "not_released" } });
    expect((await build(missionId)).current).toBe(1);
  });

  it("marks a released design released: true and records steps", async () => {
    const missionId = await missionWithSteps(true);
    expect((await build(missionId)).released).toBe(true);

    const marked = await markStep(missionId, 1);
    expect(marked.status).toBe(200);
    const after = (await marked.json()) as Answer;
    expect(after).toMatchObject({ released: true, current: 2 });
    const again = (await (await markStep(missionId, 1)).json()) as Answer;
    expect(again).toMatchObject({ released: true, current: 2 });
  });

  it("answers 404 for a step on an unknown mission", async () => {
    expect((await markStep("no-such-mission", 1)).status).toBe(404);
  });
});
