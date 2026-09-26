import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { GOLDEN } from "@vibread/fixtures";
import { KIT_WIRE_CSS, type Actor, type BuildState } from "@vibread/core";
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

/** Issue #15: the builder's wire colours are saved per mission build and show up in steps, pictures, and schematic. */
describe("wire colour overrides", () => {
  let running: RunningServer;
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-wire-colors-${randomBytes(6).toString("hex")}`,
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

  async function releasedMission(): Promise<string> {
    const { ctx } = running.context;
    const mission = await ctx.missions.create({ brief: moon.brief, inventory: moon.inventory, owner: OPERATOR });
    const revision = await ctx.store.createRevision(mission.id, { circuit: moon.circuit, suite: moon.suite, author: OPERATOR });
    const layout = layoutBoard(moon.circuit);
    await ctx.store.saveResults(mission.id, revision.n, { layout, steps: buildSteps(moon.circuit, layout) });
    await ctx.store.updateMission(mission.id, { currentRevision: revision.n, releasedRevision: revision.n });
    return mission.id;
  }

  const build = async (missionId: string) => (await (await fetch(`${base}/api/missions/${missionId}/build`)).json()) as BuildState;
  const setColor = (missionId: string, body: unknown) =>
    fetch(`${base}/api/missions/${missionId}/build/wire-color`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("suggests colours with a legend, then saves a wire's colour into text, pictures, and later reloads", async () => {
    const missionId = await releasedMission();
    const before = await build(missionId);
    expect(before.wires?.legend).toContainEqual({ colors: ["yellow", "green", "blue", "purple"], label: "LED1–LED4 (D3–D6)" });
    const d4 = before.layout!.jumpers.find((jumper) => jumper.net === "D4")!;
    expect(before.wires?.jumpers[d4.id]).toBe("green");

    const response = await setColor(missionId, { revision: 1, target: { jumper: d4.id }, color: "#FF66AA" });
    expect(response.status).toBe(200);
    const after = (await response.json()) as BuildState;
    expect(after.wires?.jumpers[d4.id]).toBe("#ff66aa");
    const step = after.steps.find((candidate) => candidate.adds.jumpers.includes(d4.id))!;
    expect(step.text).toContain("custom-colour (#ff66aa)");
    expect(step.imageUrl).toMatch(/\/build\/steps\/\d+\.png\?v=/);

    const svg = await (await fetch(`${base}${step.svgUrl}`)).text();
    expect(svg.match(new RegExp(`<g id="wire-${d4.id}"[\\s\\S]*?</g>`))?.[0]).toContain('stroke="#ff66aa"');
    const png = await fetch(`${base}${step.imageUrl}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));

    // Saved server-side: a fresh read (another device, a reload) sees it.
    expect((await build(missionId)).wires?.overrides).toEqual({ [`wire:${d4.id}`]: "#ff66aa" });
  });

  it("recolours a whole net (replacing single-wire choices on it), resets, and colours the schematic", async () => {
    const missionId = await releasedMission();
    const layout = (await build(missionId)).layout!;
    const ground = layout.jumpers.filter((jumper) => jumper.net === "GND");
    await setColor(missionId, { revision: 1, target: { jumper: ground[0]!.id }, color: "white" });
    const net = (await (await setColor(missionId, { revision: 1, target: { net: "GND" }, color: "blue" })).json()) as BuildState;
    for (const jumper of ground) expect(net.wires?.jumpers[jumper.id]).toBe("blue");
    expect(net.wires?.legend).toContainEqual({ colors: ["blue"], label: "GND (ground)" });

    await setColor(missionId, { revision: 1, target: { net: "D3" }, color: "brown" });
    const schematic = await (await fetch(`${base}${(await build(missionId)).wires!.schematicUrl}`)).text();
    expect(schematic.match(/<g class="net" data-net="D3">[\s\S]*?<\/g>/)?.[0]).toContain(`stroke="${KIT_WIRE_CSS.brown}"`);

    const reset = (await (await setColor(missionId, { revision: 1, target: { net: "GND" }, color: null })).json()) as BuildState;
    for (const jumper of ground) expect(reset.wires?.jumpers[jumper.id]).toBe("black");
  });

  it("rejects unknown wires, colours, and stale revisions", async () => {
    const missionId = await releasedMission();
    expect((await setColor(missionId, { revision: 1, target: { jumper: "W999" }, color: "red" })).status).toBe(400);
    expect((await setColor(missionId, { revision: 1, target: { net: "GND" }, color: "chartreuse" })).status).toBe(400);
    expect((await setColor(missionId, { revision: 2, target: { net: "GND" }, color: "red" })).status).toBe(400);
  });
});
