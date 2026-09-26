import type { ConsoleReport, MissionDetail, MissionService, PartType, PhotoCheckResult, ScanObservation, ToolRegistry } from "@vibread/core";
import {
  ToolInputError,
  allGo,
  errorMessage,
  createDesignOps,
  createPipeline,
  createToolRegistry,
  reviewRevision,
  type BackgroundPipeline,
  type Pipeline,
  type RegistryHooks,
} from "@vibread/tools";
import type { Express } from "express";
import { mountChat } from "./chat.js";
import type { AgentDeps } from "./deps.js";
import { anthropicModels, type AgentModels } from "./models.js";
import { StructuredAnswerError } from "./pi-object.js";
import { createRetroReviewer } from "./retro.js";
import { createRunManager } from "./runs.js";
import { createTestAuthor } from "./test-author.js";
import { createPhotoChecker } from "./vision.js";
import { createEventBus } from "./events.js";
import { createHumanRelease, type ReleaseInput } from "./release.js";
import { cutCrop, identifyParts, type AnalyzedPhoto } from "./scan.js";
import { toolTracer, tracedModels } from "./trace.js";
import { createMissionService } from "../services/missions.js";

export type { AgentDeps, InventoryReader, MessageStore, MissionEvent, MissionMachine, ServerConfig } from "./deps.js";
export type { AgentModels } from "./models.js";
export type { ReleaseInput } from "./release.js";

export interface AgentRuntime {
  missions: MissionService;
  tools: ToolRegistry;
  /** Contract Pipeline plus `idle()`, which waits for background fault dictionaries (seed script, tests). */
  pipeline: BackgroundPipeline;
  /** /api/missions/:id/chat (GET history, POST turn), /chat/stream (resume), /chat/stop. Mount after express.json(). */
  mountChat(app: Express): void;
  checkPhoto(input: { missionId: string; step: number; jpeg: Uint8Array }): Promise<PhotoCheckResult>;
  /** POST /api/missions/:id/release — the human "GO for build" (see release.ts). */
  release(input: ReleaseInput): Promise<MissionDetail>;
  /** Runs RETRO for a revision now (seed script with a key); SKIPPED when Claude isn't connected. */
  review(missionId: string, n: number): Promise<ConsoleReport>;
  /** Camera scan (plan §5.6): identify parts in photos with the owner's credential; cut review crops. */
  scan: {
    identifyParts(input: { ownerId: string; photos: Buffer[]; types: PartType[]; signal?: AbortSignal }): Promise<{ observations: ScanObservation[]; analyzed: AnalyzedPhoto[] }>;
    cutCrop(analyzedJpeg: Buffer, box: [number, number, number, number], marginPct?: number): Promise<Buffer>;
  };
}

/**
 * Composes the agent side of the server: deterministic pipeline, tool registry (single source for the pi design agent +
 * MCP), the design agent run manager (pi), independent test author, RETRO reviewer, photo check, and the MissionService
 * facade. `models` and `pipeline` are injectable for tests (pi faux design model + AI SDK mocks, a recording pipeline); by
 * default Claude with the owner's credential and the real engine pipeline.
 */
export function createAgentRuntime(deps: AgentDeps & { models?: AgentModels; pipeline?: Pipeline }): AgentRuntime {
  const direct =
    deps.models ??
    anthropicModels({
      config: deps.config,
      claudeAccounts: deps.claudeAccounts,
      log: deps.log,
      onProtocolFallback: (modelId, error) => deps.debug.event(null, "model", `${modelId}: Claude refused pi-ai's managed protocol; retried plain`, { model: modelId, error }, "warn"),
    });
  const models = tracedModels(direct, deps.debug);
  const bus = createEventBus(deps.store);
  const injected = deps.pipeline;
  const pipeline: BackgroundPipeline = injected
    ? { evaluate: (missionId, n) => injected.evaluate(missionId, n), idle: async () => {} }
    : createPipeline({ store: deps.store, log: deps.log });
  const author = createTestAuthor({ models, store: deps.store });
  const reviewer = createRetroReviewer({ models, store: deps.store });
  const { debug } = deps;

  const review: NonNullable<RegistryHooks["review"]> = async (input) => {
    const started = Date.now();
    try {
      const report = await reviewer.review(input);
      debug.event(input.mission.id, "agent", `RETRO voted ${report.verdict} on revision ${input.revision.n}: ${report.summary}`.slice(0, 300), { step: "retro", revision: input.revision.n, ms: Date.now() - started, verdict: report.verdict, concerns: report.findings.length });
      return report;
    } catch (error) {
      debug.event(input.mission.id, "agent", `RETRO couldn't review revision ${input.revision.n}`, { step: "retro", revision: input.revision.n, ms: Date.now() - started, error: errorMessage(error) }, "warn");
      throw error;
    }
  };
  const hooks: RegistryHooks = {
      async writeTests(input) {
        const started = Date.now();
        try {
          const suite = await author.write(input);
          debug.event(input.missionId, "agent", `test author wrote ${suite.scenarios.length} scenarios`, { step: "test-author", ms: Date.now() - started, scenarios: suite.scenarios.map((s) => s.id) });
          return suite;
        } catch (error) {
          debug.event(input.missionId, "agent", `test author failed: ${errorMessage(error)}`.slice(0, 300), { step: "test-author", ms: Date.now() - started, error: errorMessage(error), ...(error instanceof StructuredAnswerError ? { rawAnswer: error.raw } : {}) }, "warn");
          throw error;
        }
      },
      async reviewTests(input) {
        const started = Date.now();
        try {
          const reviews = await author.review(input);
          debug.event(input.missionId, "agent", `test review: ${reviews.map((r) => `${r.id} ${r.verdict}`).join(", ") || "no verdict"}`.slice(0, 300), { step: "test-review", ms: Date.now() - started, disputed: input.dispute !== undefined, reviews: reviews.map((r) => ({ id: r.id, verdict: r.verdict, reason: r.reason, corrected: r.scenario !== undefined })) });
          return reviews;
        } catch (error) {
          // Without a review the failures stand as they are (SIM-FAIL); the design turn goes on.
          debug.event(input.missionId, "agent", `test review failed: ${errorMessage(error)}`.slice(0, 300), { step: "test-review", ms: Date.now() - started, error: errorMessage(error), ...(error instanceof StructuredAnswerError ? { rawAnswer: error.raw } : {}) }, "warn");
          return [];
        }
      },
      review,
      onEvaluated: async (missionId, revision) => {
        const mission = await deps.store.getMission(missionId);
        const fix = mission?.releasedRevision !== undefined && ["ASSEMBLE", "VERIFY", "DEBUG"].includes(mission.phase);
        await sendMachine(deps, missionId, fix ? { type: "FIX_PROPOSED", revision: revision.n } : { type: "DESIGN_READY", revision: revision.n });
        const verdicts = Object.fromEntries(revision.results.reports.map((r) => [r.console, r.verdict]));
        debug.event(missionId, "pipeline", `revision ${revision.n} checked: ${allGo(revision.results.reports) ? "all GO" : "not all GO"}`, { revision: revision.n, verdicts });
      },
  };
  // One DesignOps for the tools and the human release: they share the test-author suite cache.
  const design = createDesignOps({ store: deps.store, pipeline, hooks });
  const tools = createToolRegistry({ store: deps.store, pipeline, hooks, design, trace: toolTracer(debug) });

  const runs = createRunManager({ ...deps, models, tools, sendMachine: (id, event) => sendMachine(deps, id, event) });
  const missions = createMissionService({ ...deps, bus, runs, sendMachine: (id, event) => sendMachine(deps, id, event) });
  const photos = createPhotoChecker({ models, store: deps.store, log: deps.log });
  // A credential probe, not a model call: untraced.
  const claudeConnected = (ownerId: string): Promise<boolean> =>
    direct.fast(ownerId, { missionId: null, purpose: "retro" }).then(
      () => true,
      () => false,
    );
  const release = createHumanRelease({
    store: deps.store,
    design,
    missions,
    review,
    claudeConnected,
    onReleased: (missionId, n) => sendMachine(deps, missionId, { type: "RELEASED", revision: n }),
  });

  return {
    missions,
    tools,
    pipeline,
    mountChat: (app) => mountChat(app, { store: deps.store, messages: deps.messages, runs, log: deps.log }),
    async checkPhoto(input) {
      const started = Date.now();
      try {
        const result = await photos.check(input);
        const counts = Object.fromEntries(["correct", "wrong", "missing", "unknown"].map((s) => [s, result.answers.filter((a) => a.status === s).length]));
        debug.event(input.missionId, "agent", `photo check step ${input.step}: ${result.summary}`.slice(0, 300), { step: "photo-check", buildStep: input.step, ms: Date.now() - started, model: result.model, answers: counts, recordedExample: result.recordedExample !== undefined });
        return result;
      } catch (error) {
        debug.event(input.missionId, "agent", `photo check step ${input.step} failed`, { step: "photo-check", buildStep: input.step, ms: Date.now() - started, error: errorMessage(error) }, "warn");
        throw error;
      }
    },
    release,
    scan: {
      async identifyParts(input) {
        const started = Date.now();
        try {
          const result = await identifyParts({ models }, input);
          debug.event(null, "scan", `scan for ${input.ownerId}: ${result.observations.length} groups in ${input.photos.length} photos`, { ownerId: input.ownerId, photos: input.photos.length, groups: result.observations.length, ms: Date.now() - started, types: result.observations.map((o) => o.typeId) });
          return result;
        } catch (error) {
          debug.event(null, "scan", `scan for ${input.ownerId} failed`, { ownerId: input.ownerId, photos: input.photos.length, ms: Date.now() - started, error: errorMessage(error) }, "warn");
          throw error;
        }
      },
      cutCrop,
    },
    async review(missionId, n) {
      const mission = await deps.store.getMission(missionId);
      if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
      const revision = await reviewRevision({ store: deps.store, mission, n, review });
      const retro = revision.results.reports.find((r) => r.console === "RETRO");
      if (!retro) throw new Error("RETRO produced no report.");
      return retro;
    },
  };
}

async function sendMachine(deps: AgentDeps, missionId: string, event: Parameters<AgentDeps["machine"]["send"]>[1]): Promise<void> {
  try {
    await deps.machine.send(missionId, event);
  } catch (error) {
    // The machine rejects transitions that don't apply in the current phase; the event is informational for us.
    deps.log.warn({ missionId, event: event.type, err: error instanceof Error ? error.message : String(error) }, "mission machine rejected event");
  }
}
