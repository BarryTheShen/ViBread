import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CircuitSchema,
  MODULE_KEYS,
  TestSuiteSchema,
  type Actor,
  type ConsoleReport,
  type MissionRecording,
  type MissionStore,
  type RecordedPhotoExample,
} from "@vibread/core";
import { reviewRevision, type Pipeline } from "@vibread/tools";
import type { UIMessage } from "ai";
import type { Express } from "express";
import { z } from "zod";
import type { MessageStore } from "../store/messages.js";
import type { MissionEvent } from "./deps.js";
import { RetroVoteSchema, retroReport } from "./retro.js";

/**
 * Recorded real-model runs (PLAN §4 "Named fallbacks": cached runs of the golden prompts, recorded photo example). They
 * carry the demo when no Claude credential exists. Everything built from them is labeled as a recording: chat messages
 * (`metadata.vibread.recorded`), the RETRO vote (`evidence.recorded`), the mission (`MissionDetail.recording`, from the
 * "mission.recorded" timeline event), and the photo example (`PhotoCheckResult.recordedExample`). Nothing replays as live.
 */
const FIXTURE = "moon-phase-lamp.2026-09-26.json";
const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.resolve("@vibread/fixtures"))), "..", "recorded");

const ModelInfo = { model: z.string().min(1), modelName: z.string().min(1) };
const InventoryItemSchema = z.object({
  module: z.enum(MODULE_KEYS),
  count: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
});

export const RecordedRunSchema = z.object({
  schema: z.literal("vibread.recorded-run/1"),
  key: z.string().min(1),
  recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provenance: z.string().min(1),
  mission: z.object({ title: z.string().min(1), brief: z.string().min(1), inventory: z.array(InventoryItemSchema) }),
  design: z.object({
    ...ModelInfo,
    startedAt: z.string(),
    finishedAt: z.string(),
    steps: z.array(
      z.union([
        z.object({ tool: z.literal("propose_design"), input: z.object({ circuit: CircuitSchema, note: z.string().optional() }), output: z.record(z.string(), z.unknown()) }),
        z.object({ tool: z.string().min(1), input: z.record(z.string(), z.unknown()), error: z.string().min(1) }),
        z.object({ text: z.string().min(1) }),
      ]),
    ),
  }),
  testAuthor: z.object({ ...ModelInfo, recordedAt: z.string(), suite: TestSuiteSchema }),
  retro: z.object({ ...ModelInfo, recordedAt: z.string(), vote: RetroVoteSchema }),
  photo: z.object({
    ...ModelInfo,
    recordedAt: z.string(),
    design: z.string(),
    step: z.number().int().positive(),
    stepTitle: z.string(),
    expectedImage: z.string().regex(/^[\w.-]+\.png$/),
    photoWasRender: z.boolean(),
    note: z.string(),
    answers: z.array(z.object({ part: z.string(), status: z.enum(["correct", "wrong", "missing", "unknown"]), note: z.string() })),
    summary: z.string(),
  }),
});
export type RecordedRun = z.infer<typeof RecordedRunSchema>;

export function loadRecordedRun(): RecordedRun {
  return RecordedRunSchema.parse(JSON.parse(readFileSync(join(RECORDED_DIR, FIXTURE), "utf8")));
}

/** "2026-09-26" → "Sep 26" (the date is part of every label, so a recording is never mistaken for today's run). */
function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface RecordedMark {
  label: string;
  model: string;
  recordedAt: string;
}

export function recordedMark(kind: "run" | "vote" | "example", info: { model: string; modelName: string }, recordedAt: string): RecordedMark {
  const noun = kind === "run" ? "Recorded run" : kind === "vote" ? "Recorded vote" : "Recorded example";
  return { label: `${noun} · ${info.modelName} · ${shortDate(recordedAt)}`, model: info.model, recordedAt };
}

export function missionRecording(run: RecordedRun): MissionRecording {
  return {
    label: `Recording of a real Claude run (${shortDate(run.recordedOn)}) — not live`,
    recordedOn: run.recordedOn,
    models: { design: run.design.modelName, testAuthor: run.testAuthor.modelName, retro: run.retro.modelName },
    provenance: run.provenance,
  };
}

/** The design agent's recorded turn as stored UI messages (what GET /chat returns), every message labeled. */
export function recordedChat(run: RecordedRun): UIMessage[] {
  const mark = recordedMark("run", run.design, run.design.startedAt);
  const metadata = { vibread: { recorded: mark } };
  const parts: UIMessage["parts"] = [];
  run.design.steps.forEach((step, index) => {
    parts.push({ type: "step-start" });
    if ("text" in step) parts.push({ type: "text", text: step.text, state: "done" });
    else if ("output" in step) {
      parts.push({ type: `tool-${step.tool}`, toolCallId: `recorded-${run.key}-${index + 1}`, state: "output-available", input: step.input, output: step.output });
    } else {
      parts.push({ type: `tool-${step.tool}`, toolCallId: `recorded-${run.key}-${index + 1}`, state: "output-error", input: step.input, errorText: step.error });
    }
  });
  return [
    { id: `recorded-${run.key}-user`, role: "user", parts: [{ type: "text", text: run.mission.brief }], metadata },
    { id: `recorded-${run.key}-assistant`, role: "assistant", parts, metadata },
  ];
}

export const PHOTO_EXAMPLE_URL_PREFIX = "/api/recorded/";

export function recordedPhotoExample(run: RecordedRun): RecordedPhotoExample {
  const { photo } = run;
  const mark = recordedMark("example", photo, photo.recordedAt);
  return {
    label: mark.label,
    note: `Photo check needs Claude, and Claude isn't connected, so your photo was not checked. This is a recorded example of what a check looks like: ${photo.modelName} checked step ${photo.step} of the ${photo.design}. ${photo.note}`,
    model: photo.model,
    recordedAt: photo.recordedAt,
    design: photo.design,
    step: photo.step,
    stepTitle: photo.stepTitle,
    imageUrl: `${PHOTO_EXAMPLE_URL_PREFIX}${photo.expectedImage}`,
    photoWasRender: photo.photoWasRender,
    answers: photo.answers,
    summary: photo.summary,
  };
}

/** Serves the recorded example picture(s); only files named by the fixture, never arbitrary paths. */
export function mountRecorded(app: Express): void {
  const run = loadRecordedRun();
  const files = new Set([run.photo.expectedImage]);
  app.get(`${PHOTO_EXAMPLE_URL_PREFIX}:file`, (req, res) => {
    const file = String(req.params.file);
    if (!files.has(file)) {
      res.status(404).json({ error: { code: "not_found", message: "No such recorded file." } });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(readFileSync(join(RECORDED_DIR, file)));
  });
}

export interface SeededRecording {
  missionId: string;
  /** Revision the recorded design agent created (no tests: FIDO/RETRO pending, as in the recording). */
  designRevision: number;
  /** Same circuit with the recorded independent suite, evaluated by the real pipeline, with the recorded RETRO vote. */
  testedRevision: number;
  reports: ConsoleReport[];
}

/**
 * Creates the recorded mission: revision 1 exactly as the recorded design agent left it (real pipeline, no tests),
 * the chat replayed into stored UI messages, then revision 2 = the same circuit with the recorded test author's suite
 * (the real simulator runs it) and the recorded RETRO vote — attached only if every deterministic console is GO.
 */
export async function seedRecordedMission(deps: {
  store: MissionStore;
  messages: MessageStore;
  pipeline: Pipeline;
  sendMachine: (missionId: string, event: MissionEvent) => Promise<unknown>;
  ownerId: string;
  run?: RecordedRun;
}): Promise<SeededRecording> {
  const { store, messages, pipeline } = deps;
  const run = deps.run ?? loadRecordedRun();
  const designMark = recordedMark("run", run.design, run.design.startedAt);
  const designActor: Actor = { kind: "agent", id: "design-agent", name: `Design agent (${designMark.label})`, channel: "system" };
  const system: Actor = { kind: "system", id: "recorded-run", name: "Recorded run", channel: "system" };

  const mission = await store.createMission({ title: run.mission.title, brief: run.mission.brief, ownerId: deps.ownerId, inventory: run.mission.inventory });
  const recording = missionRecording(run);
  await store.appendEvent({ missionId: mission.id, channel: "system", actor: system, kind: "mission.recorded", text: recording.label, data: recording });
  await deps.sendMachine(mission.id, { type: "DESIGN_STARTED" });

  const proposed = run.design.steps.find((s): s is Extract<RecordedRun["design"]["steps"][number], { tool: "propose_design" }> => "tool" in s && s.tool === "propose_design");
  if (!proposed) throw new Error("recorded run has no propose_design step");
  const first = await store.createRevision(mission.id, { circuit: proposed.input.circuit, author: designActor, note: proposed.input.note ?? "First design" });
  await store.updateMission(mission.id, { currentRevision: first.n });
  await store.appendEvent({ missionId: mission.id, channel: "system", actor: designActor, kind: "revision.created", text: `Revision ${first.n}: ${proposed.input.note ?? run.mission.title} (${designMark.label})`, revision: first.n, data: { hash: first.hash, recorded: designMark } });
  await pipeline.evaluate(mission.id, first.n);
  await reviewRevision({ store, mission, n: first.n }); // PENDING: no tests yet, exactly as in the recording

  const chat = recordedChat(run);
  await messages.save(mission.id, chat);
  for (const message of chat) {
    const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
    if (!text) continue;
    await store.appendEvent({
      missionId: mission.id,
      channel: "system",
      actor: message.role === "user" ? system : designActor,
      kind: "message",
      text: `[${designMark.label}] ${text}`.slice(0, 2000),
      data: { recorded: designMark },
    });
  }

  const authorMark = recordedMark("run", run.testAuthor, run.testAuthor.recordedAt);
  const author: Actor = { kind: "agent", id: "test-author", name: `Independent test author (${authorMark.label})`, channel: "system" };
  const tested = await store.createRevision(mission.id, { circuit: first.circuit, suite: run.testAuthor.suite, author, note: `Independent tests added to revision ${first.n} (${authorMark.label})`, parent: first.n });
  await store.updateMission(mission.id, { currentRevision: tested.n });
  await store.appendEvent({
    missionId: mission.id,
    channel: "system",
    actor: author,
    kind: "revision.created",
    text: `Revision ${tested.n}: revision ${first.n} with ${run.testAuthor.suite.scenarios.length} independent simulation tests (${authorMark.label})`,
    revision: tested.n,
    data: { hash: tested.hash, parent: first.n, recorded: authorMark },
  });
  const results = await pipeline.evaluate(mission.id, tested.n);

  const voteMark = recordedMark("vote", run.retro, run.retro.recordedAt);
  const allDeterministicGo = (["EECOM", "GUIDO", "FIDO", "FAO"] as const).every((id) => results.reports.find((r) => r.console === id)?.verdict === "GO");
  let reports = results.reports;
  if (allDeterministicGo) {
    const base = retroReport(run.retro.vote, tested.hash, run.retro.model);
    const retro: ConsoleReport = { ...base, summary: `${voteMark.label}: ${base.summary}`, evidence: { ...base.evidence, recorded: voteMark } };
    reports = [...results.reports.filter((r) => r.console !== "RETRO"), retro];
    await store.saveResults(mission.id, tested.n, { reports });
    await store.appendEvent({
      missionId: mission.id,
      channel: "system",
      actor: { kind: "agent", id: "retro", name: `RETRO reviewer (${voteMark.label})`, channel: "system" },
      kind: "console.report",
      text: `Independent review (RETRO): ${retro.verdict} — ${retro.summary}`,
      revision: tested.n,
      data: { console: "RETRO", verdict: retro.verdict, reasons: run.retro.vote.reasons, recorded: voteMark },
    });
  } else {
    reports = (await reviewRevision({ store, mission, n: tested.n })).results.reports;
  }
  await deps.sendMachine(mission.id, { type: "DESIGN_READY", revision: tested.n });
  return { missionId: mission.id, designRevision: first.n, testedRevision: tested.n, reports };
}
