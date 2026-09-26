import { GOLDEN } from "@vibread/fixtures";
import { createPipeline } from "@vibread/tools";
import { memoryStore } from "/home/barry/hackwashu/projects/vibread/apps/server/src/agents/testing.ts";
for (const g of GOLDEN) {
  const store = memoryStore();
  const m = await store.createMission({ title: "t", brief: g.brief, ownerId: "o", inventory: g.inventory, mode: "review" });
  await store.createRevision(m.id, { circuit: g.circuit, suite: g.suite, author: { kind: "human", id: "o", channel: "web" } });
  const p = createPipeline({ store });
  for (const run of ["cold", "warm"]) {
    const t = performance.now();
    const r = await p.evaluate(m.id, 1);
    const ev = (await store.listEvents(m.id)).filter((e) => e.kind === "console.report").at(-1)!.data as { timings: Record<string, number> };
    console.log(g.key, run, Math.round(performance.now() - t), "ms", r.reports.map((x) => `${x.console}:${x.verdict}`).join(" "), JSON.stringify(ev.timings));
  }
}
process.exit(0);
