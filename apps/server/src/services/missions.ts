import { randomUUID } from "node:crypto";
import {
  BOARD_VARIANTS,
  BREADBOARD_PROFILES,
  CONSOLE_IDS,
  PART_VARIANTS,
  toMissionInventory,
  type Actor,
  type AgentTurnResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalView,
  type BuildState,
  type InventoryItem,
  type Mission,
  type MissionDetail,
  type MissionRecording,
  type MissionService,
  type MissionSummary,
  type MyHardware,
  type Revision,
  type RevisionSummary,
} from "@vibread/core";
import { ToolInputError, artifactUrl, errorMessage } from "@vibread/tools";
import type { UIMessage } from "ai";
import type { AgentDeps, MissionEvent } from "../agents/deps.js";
import type { EventBus } from "../agents/events.js";
import { AgentBusyError, type RunManager } from "../agents/runs.js";
import { wireOverrides, withWireColors } from "./wire-colors.js";
import { MISSION_HARDWARE_EVENT } from "./hardware.js";

export class ApprovalNotFoundError extends Error {
  readonly code = "approval_not_found";
  readonly status = 404;
  constructor(id: string) {
    super(`Approval ${id} does not exist.`);
    this.name = "ApprovalNotFoundError";
  }
}

function summary(mission: Mission, agentBusy = false): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    brief: mission.brief,
    phase: mission.phase,
    ...(mission.currentRevision !== undefined ? { currentRevision: mission.currentRevision } : {}),
    ...(mission.releasedRevision !== undefined ? { releasedRevision: mission.releasedRevision } : {}),
    updatedAt: mission.updatedAt,
    ...(agentBusy ? { agentBusy: true } : {}),
  };
}

function revisionSummary(revision: Revision): RevisionSummary {
  const verdicts: RevisionSummary["verdicts"] = {};
  for (const r of revision.results.reports) verdicts[r.console] = r.verdict;
  return { n: revision.n, hash: revision.hash, ...(revision.note ? { note: revision.note } : {}), author: revision.author, createdAt: revision.createdAt, verdicts };
}

function hardwareText(hardware: MyHardware): string {
  const parts = Object.entries(hardware.parts).flatMap(([module, key]) => PART_VARIANTS.filter((variant) => variant.module === module && variant.variant === key).map((variant) => variant.name));
  return `Building on your ${BREADBOARD_PROFILES[hardware.breadboard].shortName} with your ${BOARD_VARIANTS[hardware.board].shortName}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

/** Parts of a module whose variant you picked get `params.variant` (an explicit variant already on the item wins). */
function withHardwareVariants(inventory: InventoryItem[], hardware: MyHardware): InventoryItem[] {
  return inventory.map((item) => {
    const variant = hardware.parts[item.module];
    return variant === undefined || item.params?.variant !== undefined ? item : { ...item, params: { ...item.params, variant } };
  });
}

function titleFrom(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/)[0] ?? "New mission";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/**
 * MissionService (packages/core services.ts) on store + broker + machine + the design-agent run manager. There are no
 * permission modes; the only approvals are physical bench requests (decide = a person's decision or iMessage pre-approval).
 */
export function createMissionService(
  deps: AgentDeps & { bus: EventBus; runs: RunManager; sendMachine: (missionId: string, event: MissionEvent) => Promise<void> },
): MissionService {
  const { store, broker, runs } = deps;

  function view(request: ApprovalRequest): ApprovalView {
    return {
      id: request.id,
      missionId: request.missionId,
      actionClass: request.actionClass,
      action: request.action,
      summary: request.summary,
      consequence: request.consequence,
      revisionHash: request.revisionHash,
      status: request.status,
      requestedBy: request.requestedBy,
      ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
      ...(request.decision ? { decision: request.decision } : {}),
      ...(request.preApprovedBy ? { preApprovedBy: request.preApprovedBy } : {}),
      expiresAt: request.expiresAt,
    };
  }

  async function requireMission(missionId: string): Promise<Mission> {
    const mission = await store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    return mission;
  }

  const service: MissionService = {
    async create(input) {
      // Explicit parts (older clients, MCP/A2A callers that send them) win; otherwise the owner's ready inventory entries
      // (all, or only inventoryEntryIds) are copied in through each part type's mapping (plan §5.4). This is the one
      // creation path for web, iMessage (CAPCOM), MCP and A2A.
      let inventory = input.inventory;
      let inventoryNotes: string[] | undefined;
      if (!inventory) {
        const [entries, types] = await Promise.all([deps.inventory.entries(input.owner.id), deps.inventory.types(input.owner.id)]);
        const wanted = input.inventoryEntryIds ? new Set(input.inventoryEntryIds) : undefined;
        const copied = toMissionInventory(wanted ? entries.filter((e) => wanted.has(e.id)) : entries, types);
        inventory = copied.items;
        inventoryNotes = copied.notes.length ? copied.notes : undefined;
      }
      // Issue #23: the owner's hardware is snapshotted with the mission (the design agent builds for it), and the part
      // variants they own ride along in the parts' params so the circuit, steps and pictures name them.
      const hardware = (await deps.hardware?.get(input.owner.id))?.hardware;
      if (hardware) inventory = withHardwareVariants(inventory, hardware);
      const mission = await store.createMission({
        title: input.title?.trim() || titleFrom(input.brief),
        brief: input.brief,
        ownerId: input.owner.id,
        inventory,
        ...(inventoryNotes ? { inventoryNotes } : {}),
      });
      // store.createMission records the "mission.created" timeline event itself (ServerCore's SQL store).
      if (hardware) {
        await store.appendEvent({ missionId: mission.id, channel: "system", actor: { kind: "system", id: "inventory", name: "Your hardware", channel: "system" }, kind: MISSION_HARDWARE_EVENT, text: hardwareText(hardware), data: hardware });
      }
      await deps.sendMachine(mission.id, { type: "BRIEF_RECEIVED" });
      return (await store.getMission(mission.id)) ?? mission;
    },

    async list(ownerId) {
      return (await store.listMissions(ownerId)).map((mission) => summary(mission, runs.active(mission.id) !== undefined));
    },

    async detail(missionId) {
      const mission = await requireMission(missionId);
      const revision = await store.getRevision(missionId);
      const released = mission.releasedRevision !== undefined ? await store.getRevision(missionId, mission.releasedRevision) : null;
      const pending = await broker.listPending(missionId);
      const consoles = CONSOLE_IDS.flatMap((id) => revision?.results.reports.filter((r) => r.console === id) ?? []);
      // A replay of a recorded real-model run is marked by its "mission.recorded" timeline event (recorded.ts).
      const recording = (await store.listEvents(missionId)).find((e) => e.kind === "mission.recorded")?.data as MissionRecording | undefined;
      return {
        mission,
        ...(revision ? { revision: revisionSummary(revision) } : {}),
        ...(released ? { released: revisionSummary(released) } : {}),
        consoles,
        pendingApprovals: pending.map(view),
        agentBusy: runs.active(missionId) !== undefined,
        ...(recording ? { recording } : {}),
      } satisfies MissionDetail;
    },

    async say(missionId, text, actor) {
      await requireMission(missionId);
      const message: UIMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text }], metadata: { vibread: { actor } } };
      let run;
      for (;;) {
        const busy = runs.active(missionId);
        if (busy) {
          await busy.finished;
          continue;
        }
        try {
          run = await runs.start(missionId, { message, actor });
          break;
        } catch (error) {
          if (!(error instanceof AgentBusyError)) throw error;
        }
      }
      const outcome = await run.finished;
      const mission = await requireMission(missionId);
      const pending = await broker.listPending(missionId);
      const result: AgentTurnResult = {
        text: outcome.error ? [outcome.text, outcome.error].filter(Boolean).join("\n\n") : outcome.text,
        ...(outcome.question ? { question: outcome.question } : {}),
        pendingApprovals: pending.map(view),
        ...(mission.currentRevision !== undefined ? { revision: mission.currentRevision } : {}),
      };
      return result;
    },

    async decide(approvalId, decision: ApprovalDecision, actor) {
      const existing = await broker.get(approvalId);
      if (!existing) throw new ApprovalNotFoundError(approvalId);
      const missionId = existing.missionId;
      // Only the mission's owner decides (web session or their linked iMessage handle). Someone else's → 404.
      if (actor.kind === "human" && (await store.getMission(missionId))?.ownerId !== actor.id) throw new ApprovalNotFoundError(approvalId);

      let request: ApprovalRequest;
      try {
        request = await broker.decide(approvalId, decision, actor);
      } catch (error) {
        // The broker is the authority (e.g. remote/agent actors may request but never approve).
        throw Object.assign(new ToolInputError(errorMessage(error), 403), { code: "approval_forbidden" });
      }
      await store.appendEvent({
        missionId: request.missionId,
        channel: actor.channel,
        actor,
        kind: "approval.decided",
        text: `${request.summary}: ${request.status === "approved" ? "approved" : request.status}`,
        data: { approvalId: request.id, decision, status: request.status, action: request.action },
      });
      return view(request);
    },

    async build(missionId) {
      const mission = await requireMission(missionId);
      const n = mission.releasedRevision ?? mission.currentRevision;
      const revision = n !== undefined ? await store.getRevision(missionId, n) : null;
      const steps = revision?.results.steps?.steps ?? [];
      const events = await store.listEvents(missionId);
      const done = events
        .filter((e) => e.kind === "build.step" && (revision === null || e.revision === undefined || e.revision === revision.n))
        .map((e) => Number((e.data as { n?: unknown } | undefined)?.n))
        .filter((x) => Number.isInteger(x));
      const current = Math.min(Math.max(1, (done.length ? Math.max(...done) : 0) + 1), Math.max(steps.length, 1));
      const headlineEvent = events.findLast((e) => ["bench.run", "photo.checked", "build.step", "revision.released"].includes(e.kind));
      const baseSteps: BuildState["steps"] = steps.map((s) => ({
        ...s,
        ...(revision && revision.results.artifacts[`step-${s.n}.png`] ? { imageUrl: artifactUrl(missionId, revision.n, `step-${s.n}.png`) } : {}),
        ...(revision && revision.results.artifacts[`step-${s.n}-focus.png`] ? { focusImageUrl: artifactUrl(missionId, revision.n, `step-${s.n}-focus.png`) } : {}),
      }));
      const colored = revision ? withWireColors(missionId, revision, baseSteps, wireOverrides(events, revision.n)) : { steps: baseSteps };
      const state: BuildState = {
        missionId,
        ...(revision ? { revision: revision.n } : {}),
        ...(revision?.results.layout ? { layout: revision.results.layout } : {}),
        steps: colored.steps,
        ...(colored.wires ? { wires: colored.wires } : {}),
        current,
        plug: steps[current - 1]?.plug ?? "unplugged",
        ...(headlineEvent ? { headline: headlineEvent.text } : {}),
        updatedAt: headlineEvent?.at ?? mission.updatedAt,
      };
      return state;
    },

    events: (missionId, afterId) => store.listEvents(missionId, afterId),

    subscribe: (missionId, listener) => deps.bus.subscribe(missionId, listener),
  };
  return service;
}
