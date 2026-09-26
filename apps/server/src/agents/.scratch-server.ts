import express from "express";
import { GOLDEN } from "@vibread/fixtures";
import { createAgentRuntime } from "./index.js";
import { jsonModel, mockModels, scriptedModel, testDeps } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const deps = testDeps();
const design = scriptedModel([
  (options) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") return { text: "Revision saved — the consoles are in. Next: approve the release when you're happy." };
    return { text: "I'll design your Moon-Phase Lamp.", toolCalls: [{ name: "propose_design", input: { circuit: golden.circuit, note: "First design" } }] };
  },
  { text: "Revision saved — the consoles are in." },
]);
const fast = jsonModel((call) => (JSON.stringify(call.prompt).includes("RETRO") ? { verdict: "GO", summary: "Looks right.", reasons: ["ok"], concerns: [] } : golden.suite));
const runtime = createAgentRuntime({ ...deps, models: mockModels(design, fast) });
const mission = await runtime.missions.create({
  brief: golden.brief,
  inventory: golden.inventory,
  mode: "ask",
  owner: { kind: "human", id: "operator", name: "Operator", channel: "web" },
});

const app = express();
app.use(express.json());
runtime.mountChat(app);
app.get("/api/missions/:id", async (req, res) => void res.json(await runtime.missions.detail(req.params.id)));
app.post("/api/approvals/:id", async (req, res) => {
  const view = await runtime.missions.decide(req.params.id, req.body.decision, { kind: "human", id: "operator", name: "Operator", channel: "web" });
  res.json(view);
});
app.listen(8802, "0.0.0.0", () => console.log(`scratch ready mission=${mission.id}`));
