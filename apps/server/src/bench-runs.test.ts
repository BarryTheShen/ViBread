import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { planSelfTest } from "@vibread/bench";
import type { Actor, BenchRunResult, DeviceLine } from "@vibread/core";
import { revisionHash } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { startServer, type RunningServer } from "./main.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OPERATOR: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Issue 21: a Build Steps checkpoint (`/bench?tests=…`) runs a few of the revision's self-tests. The server judged the
 * run against the whole plan, so tests nobody ran made every checkpoint INCOMPLETE.
 */
describe("POST /api/missions/:id/bench/runs", () => {
  let running: RunningServer;
  let base: string;
  let missionId: string;
  const plan = planSelfTest(golden.circuit, revisionHash(golden.circuit, golden.suite));
  const board = plan.board;
  const railLines: DeviceLine[] = [
    { t: "hello", fw: "vibread-bench", proto: 1, design: plan.design, board },
    { t: "begin", test: "rails.vcc" },
    { t: "vcc", mv: 5000 },
    { t: "end", test: "rails.vcc", status: "pass" },
  ];
  const post = async (tests: string[]): Promise<BenchRunResult> => {
    const response = await fetch(`${base}/api/missions/${missionId}/bench/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, kind: "selftest", plan: { ...plan, tests }, lines: railLines, answers: {}, runId: "virtual-test" }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as BenchRunResult;
  };

  beforeAll(async () => {
    const port = await freePort();
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-bench-runs-${randomBytes(6).toString("hex")}`,
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
    });
    process.env.LOG_LEVEL ??= "silent";
    process.env.VIBREAD_NO_STATIC = "1";
    running = await startServer(config);
    base = `http://127.0.0.1:${port}`;
    const { ctx } = running.context;
    const mission = await ctx.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OPERATOR });
    const revision = await ctx.store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author: OPERATOR });
    await ctx.store.saveResults(mission.id, revision.n, { selftest: plan });
    missionId = mission.id;
  }, 60_000);
  afterAll(async () => {
    await running?.close();
  });

  it("judges a checkpoint run by the tests it asked for, and a full run by the whole plan", async () => {
    expect(plan.tests.length).toBeGreaterThan(1);
    const checkpoint = await post(["rails.vcc"]);
    expect(checkpoint.results.map((result) => result.test)).toEqual(["rails.vcc"]);
    expect(checkpoint.verdict).toBe("pass");

    const full = await post(plan.tests);
    expect(full.verdict).toBe("incomplete");
  });

  it("ignores tests the server's plan doesn't have", async () => {
    // The moon lamp has no knob: a client asking for pot.sweep can't add it.
    expect(plan.tests).not.toContain("pot.sweep");
    const run = await post(["rails.vcc", "pot.sweep"]);
    expect(run.results.map((result) => result.test)).toEqual(["rails.vcc"]);
  });
});
