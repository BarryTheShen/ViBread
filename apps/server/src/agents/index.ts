import type { ConsoleReport, MissionDetail, MissionService, PhotoCheckResult, ToolRegistry } from "@vibread/core";
import {
  ToolInputError,
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
import { createRetroReviewer } from "./retro.js";
import { createRunManager } from "./runs.js";
import { createTestAuthor } from "./test-author.js";
import { createPhotoChecker } from "./vision.js";
import { createEventBus } from "./events.js";
import { createApprovalLinks } from "./approval-links.js";
import { createHumanRelease, type ReleaseInput } from "./release.js";
import { createMissionService } from "../services/missions.js";

export type { AgentDeps, MessageStore, MissionEvent, MissionMachine, ServerConfig } from "./deps.js";
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
}

/**
 * Composes the agent side of the server: deterministic pipeline, tool registry (single source for AI SDK + MCP), the
 * design agent run manager, independent test author, RETRO reviewer, photo check, and the MissionService facade.
 * `models` and `pipeline` are injectable for tests (AI SDK mock models, a recording pipeline); by default Claude via
 * @ai-sdk/anthropic with config keys and the real engine pipeline.
 */
export function createAgentRuntime(deps: AgentDeps & { models?: AgentModels; pipeline?: Pipeline }): AgentRuntime {
  const models = deps.models ?? anthropicModels({ config: deps.config, claudeAccounts: deps.claudeAccounts });
  const bus = createEventBus(deps.store);
  const injected = deps.pipeline;
  const pipeline: BackgroundPipeline = injected
    ? { evaluate: (missionId, n) => injected.evaluate(missionId, n), idle: async () => {} }
    : createPipeline({ store: deps.store, log: deps.log });
  const author = createTestAuthor({ models, store: deps.store });
  const reviewer = createRetroReviewer({ models, store: deps.store });
  const links = createApprovalLinks({ messages: deps.messages });

  const hooks: RegistryHooks = {
      writeTests: author.write,
      review: reviewer.review,
      onEvaluated: async (missionId, revision) => {
        const mission = await deps.store.getMission(missionId);
        const fix = mission?.releasedRevision !== undefined && ["ASSEMBLE", "VERIFY", "DEBUG"].includes(mission.phase);
        await sendMachine(deps, missionId, fix ? { type: "FIX_PROPOSED", revision: revision.n } : { type: "DESIGN_READY", revision: revision.n });
      },
      onReleased: async (missionId, n) => {
        await sendMachine(deps, missionId, { type: "RELEASED", revision: n });
      },
  };
  // One DesignOps for the tools and the human release: they share the test-author suite cache.
  const design = createDesignOps({ store: deps.store, pipeline, hooks });
  const tools = createToolRegistry({ store: deps.store, pipeline, hooks, design });

  const runs = createRunManager({ ...deps, models, tools, links, sendMachine: (id, event) => sendMachine(deps, id, event) });
  const missions = createMissionService({ ...deps, bus, runs, links, sendMachine: (id, event) => sendMachine(deps, id, event) });
  const photos = createPhotoChecker({ models, store: deps.store, log: deps.log });
  const claudeConnected = (ownerId: string): Promise<boolean> =>
    models.fast(ownerId).then(
      () => true,
      () => false,
    );
  const release = createHumanRelease({ store: deps.store, broker: deps.broker, tools, design, missions, runs, links, review: reviewer.review, claudeConnected });

  return {
    missions,
    tools,
    pipeline,
    mountChat: (app) => mountChat(app, { store: deps.store, messages: deps.messages, runs, links, log: deps.log }),
    checkPhoto: (input) => photos.check(input),
    release,
    async review(missionId, n) {
      const mission = await deps.store.getMission(missionId);
      if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
      const revision = await reviewRevision({ store: deps.store, mission, n, review: reviewer.review });
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
