// Pre-warmed demo missions (PLAN §3): creates one mission per golden design with its revision evaluated by the real
// pipeline (checks, compile, simulation, layout, steps, schematic, bench firmware), owned by the single operator.
// Usage: DATA_DIR=./data npx tsx scripts/seed-golden.ts [moon-phase-lamp|knob-night-light|launch-control ...]
import { GOLDEN } from "@vibread/fixtures";
import { loadConfig } from "../apps/server/src/config.js";
import { createAppContext } from "../apps/server/src/context.js";

const wanted = new Set(process.argv.slice(2));
const designs = GOLDEN.filter((g) => wanted.size === 0 || wanted.has(g.key));
if (designs.length === 0) throw new Error(`unknown design key(s): ${[...wanted].join(", ")}`);

const { ctx, close } = createAppContext({ config: loadConfig() });
try {
  const operator = await ctx.operator();
  const author = { kind: "system" as const, id: "golden-fixture", name: "ViBread golden design", channel: "system" as const };
  for (const golden of designs) {
    const mission = await ctx.store.createMission({
      title: golden.circuit.title,
      brief: golden.brief,
      ownerId: operator.id,
      inventory: golden.inventory,
      mode: "review",
    });
    await ctx.machine.send(mission.id, { type: "DESIGN_STARTED" });
    const revision = await ctx.store.createRevision(mission.id, {
      circuit: golden.circuit,
      suite: golden.suite,
      author,
      note: "Pre-warmed golden design",
    });
    await ctx.store.updateMission(mission.id, { currentRevision: revision.n });
    const started = performance.now();
    const results = await ctx.runtime.pipeline.evaluate(mission.id, revision.n);
    // With a key, pre-warmed missions carry a real RETRO vote (the golden suites stay; the test author isn't re-run).
    const retro = ctx.config.anthropicApiKey ? await ctx.runtime.review(mission.id, revision.n) : undefined;
    const reports = retro ? [...results.reports.filter((r) => r.console !== "RETRO"), retro] : results.reports;
    await ctx.machine.send(mission.id, { type: "DESIGN_READY", revision: revision.n });
    const verdicts = reports.map((r) => `${r.console} ${r.verdict}`).join(" · ");
    console.log(`${golden.key}: mission ${mission.id} r${revision.n} in ${Math.round(performance.now() - started)} ms — ${verdicts}`);
  }
  // Fault dictionaries (faults.json) build in the background; wait so they're saved before the database closes.
  const waiting = performance.now();
  await ctx.runtime.pipeline.idle();
  console.log(`fault dictionaries ready in ${Math.round(performance.now() - waiting)} ms`);
} finally {
  await close();
}
