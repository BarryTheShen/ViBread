import { GOLDEN } from "@vibread/fixtures";
import { parseCircuit, type Actor } from "@vibread/core";
import { createPipeline } from "@vibread/tools";
import { validateUIMessages } from "ai";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { anthropicModels } from "./models.js";
import { loadRecordedRun, recordedChat, seedRecordedMission } from "./recorded.js";
import { testDeps } from "./testing.js";

const OWNER: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };

describe("recorded real-model run (PLAN §4 named fallback)", () => {
  it("the fixture is dated, names its models, and every artifact in it is valid", () => {
    const run = loadRecordedRun();
    expect(run.recordedOn).toBe("2026-09-26");
    expect([run.design.model, run.testAuthor.model, run.retro.model, run.photo.model]).toEqual(["claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5"]);
    const proposed = run.design.steps.find((s) => "tool" in s && s.tool === "propose_design");
    expect(proposed && "output" in proposed && parseCircuit(proposed.input.circuit).ok).toBe(true);
    expect(run.testAuthor.suite.author).toBe("test-author");
    expect(run.retro.vote.verdict).toBe("GO");
    expect(run.photo.photoWasRender).toBe(true); // no real photo existed; the example must say so
  });

  it("replays into valid UI messages, every one labeled as a recording", async () => {
    const chat = recordedChat(loadRecordedRun());
    await expect(validateUIMessages({ messages: chat })).resolves.toHaveLength(2);
    for (const message of chat) {
      expect(message.metadata).toEqual({ vibread: { recorded: { label: "Recorded run · Claude Opus 5.5 · Sep 26", model: "claude-opus-5-5", recordedAt: "2026-09-26T10:08:58-05:00" } } });
    }
    const tools = chat[1]!.parts.filter((p) => p.type.startsWith("tool-")).map((p) => [p.type, "state" in p ? p.state : undefined]);
    expect(tools).toEqual([["tool-propose_design", "output-available"], ["tool-run_scenarios", "output-error"]]);
  });

  it("seeds the mission: recorded chat, revision as the agent left it, tested revision with a recorded RETRO vote", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    const seeded = await seedRecordedMission({
      store: deps.store,
      messages: deps.messages,
      pipeline: createPipeline({ store: deps.store, faults: false }),
      sendMachine: (id, event) => deps.machine.send(id, event),
      ownerId: OWNER.id,
    });
    const detail = await runtime.missions.detail(seeded.missionId);
    expect(detail.recording).toMatchObject({ label: "Recording of a real Claude run (Sep 26) — not live", models: { design: "Claude Opus 5.5", testAuthor: "Claude Sonnet 5", retro: "Claude Sonnet 5" } });

    const first = (await deps.store.getRevision(seeded.missionId, seeded.designRevision))!;
    expect(first.suite).toBeUndefined();
    expect(Object.fromEntries(first.results.reports.map((r) => [r.console, r.verdict]))).toEqual({ EECOM: "GO", GUIDO: "GO", FIDO: "PENDING", FAO: "GO", RETRO: "PENDING" });

    // The recorded suite runs in the real simulator on the recorded design; RETRO is the recorded vote, labeled.
    expect(detail.revision?.n).toBe(seeded.testedRevision);
    expect(detail.revision?.verdicts).toEqual({ EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO", RETRO: "GO" });
    const retro = detail.consoles.find((c) => c.console === "RETRO")!;
    expect(retro.evidence?.recorded).toEqual({ label: "Recorded vote · Claude Sonnet 5 · Sep 26", model: "claude-sonnet-5", recordedAt: "2026-09-26T10:17:00-05:00" });
    expect(retro.summary.startsWith("Recorded vote · Claude Sonnet 5 · Sep 26: ")).toBe(true);

    expect(await deps.messages.list(seeded.missionId)).toEqual(recordedChat(loadRecordedRun()));
    const messageEvents = (await runtime.missions.events(seeded.missionId)).filter((e) => e.kind === "message");
    expect(messageEvents.length).toBe(2);
    expect(messageEvents.every((e) => e.text.startsWith("[Recorded run · Claude Opus 5.5 · Sep 26] "))).toBe(true);

    // Golden missions are not recordings.
    const golden = await runtime.missions.create({ brief: GOLDEN[0]!.brief, inventory: GOLDEN[0]!.inventory, owner: OWNER });
    expect((await runtime.missions.detail(golden.id)).recording).toBeUndefined();
  }, 60_000);

  it("without Claude the photo check returns a labeled recorded example and does not analyze the photo", async () => {
    const deps = testDeps();
    const runtime = createAgentRuntime({ ...deps, models: anthropicModels({ config: { model: "m", fastModel: "f" } }) });
    const mission = await runtime.missions.create({ brief: GOLDEN[0]!.brief, inventory: GOLDEN[0]!.inventory, owner: OWNER });
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#777" } }).jpeg().toBuffer();
    const result = await runtime.checkPhoto({ missionId: mission.id, step: 5, jpeg: new Uint8Array(jpeg) });
    expect(result.step).toBe(5);
    expect(result.answers).toEqual([]);
    expect(result.model).toBe("none");
    expect(result.summary).toContain("your photo was not checked");
    expect(result.recordedExample).toMatchObject({
      label: "Recorded example · Claude Sonnet 5 · Sep 26",
      step: 12,
      imageUrl: "/api/recorded/photo-example-step-12.png",
      photoWasRender: true,
    });
    expect(result.recordedExample?.note).toContain("your photo was not checked");
    expect(result.recordedExample?.answers.length).toBeGreaterThan(0);
  });
});
