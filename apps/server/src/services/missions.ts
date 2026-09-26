import { randomUUID } from "node:crypto";
import {
  CONSOLE_IDS,
  type Actor,
  type AgentTurnResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalView,
  type BuildState,
  type Mission,
  type MissionDetail,
  type MissionService,
  type MissionSummary,
  type Revision,
  type RevisionSummary,
} from "@vibread/core";
import { ToolInputError, artifactUrl, errorMessage } from "@vibread/tools";
import type { UIMessage } from "ai";
import type { AgentDeps, MissionEvent } from "../agents/deps.js";
import type { ApprovalLinks } from "../agents/approval-links.js";
import type { EventBus } from "../agents/events.js";
import { AgentBusyError, type RunManager } from "../agents/runs.js";

export class ApprovalNotFoundError extends Error {
  readonly code = "approval_not_found";
  readonly status = 404;
  constructor(id: string) {
    super(`Approval ${id} does not exist.`);
    this.name = "ApprovalNotFoundError";
  }
}

function summary(mission: Mission): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    brief: mission.brief,
    mode: mission.mode,
    phase: mission.phase,
    ...(mission.currentRevision !== undefined ? { currentRevision: mission.currentRevision } : {}),
    ...(mission.releasedRevision !== undefined ? { releasedRevision: mission.releasedRevision } : {}),
    updatedAt: mission.updatedAt,
  };
}

function revisionSummary(revision: Revision): RevisionSummary {
  const verdicts: RevisionSummary["verdicts"] = {};
  for (const r of revision.results.reports) verdicts[r.console] = r.verdict;
  return { n: revision.n, hash: revision.hash, ...(revision.note ? { note: revision.note } : {}), author: revision.author, createdAt: revision.createdAt, verdicts };
}

function titleFrom(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/)[0] ?? "New mission";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/**
 * MissionService (packages/core services.ts) on store + broker + machine + the design-agent run manager. Chat approvals
 * are exposed under their chat (AI SDK) approval id; `decide` accepts that id or the broker id, writes the decision into
 * the stored tool part, and resumes the agent exactly once when the assistant message has no approvals left open.
 */
export function createMissionService(
  deps: AgentDeps & { bus: EventBus; runs: RunManager; links: ApprovalLinks; sendMachine: (missionId: string, event: MissionEvent) => Promise<void> },
): MissionService {
  const { store, broker, messages, runs, links } = deps;

  function view(request: ApprovalRequest): ApprovalView {
    const link = links.forBroker(request.id);
    return {
      id: link?.approvalId ?? request.id,
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

  /** Writes the broker's decision into the stored tool part. Returns true if the part was still open (first decision). */
  async function applyToHistory(missionId: string, approvalId: string, request: ApprovalRequest, decider: Actor): Promise<{ applied: boolean; ready: boolean }> {
    const history = await messages.list(missionId);
    let applied = false;
    let ready = false;
    const next = history.map((message): UIMessage => {
      if (message.role !== "assistant") return message;
      let touched = false;
      const parts = message.parts.map((part) => {
        if (!("approval" in part) || !part.approval || part.approval.id !== approvalId || !("state" in part) || part.state !== "approval-requested") return part;
        touched = true;
        const approved = request.status === "approved" || request.status === "consumed";
        return {
          ...part,
          state: "approval-responded" as const,
          approval: {
            ...part.approval,
            approved,
            ...(approved ? {} : { reason: `${request.status === "expired" ? "Expired" : "Denied"} by ${decider.name ?? decider.id}` }),
          },
        };
      });
      if (!touched) return message;
      applied = true;
      ready = !parts.some((p) => "state" in p && p.state === "approval-requested");
      return { ...message, parts } as UIMessage;
    });
    if (applied) await messages.save(missionId, next);
    return { applied, ready };
  }

  const service: MissionService = {
    async create(input) {
      const mission = await store.createMission({
        title: input.title?.trim() || titleFrom(input.brief),
        brief: input.brief,
        ownerId: input.owner.id,
        inventory: input.inventory,
        mode: input.mode ?? "review",
      });
      // store.createMission records the "mission.created" timeline event itself (ServerCore's SQL store).
      await deps.sendMachine(mission.id, { type: "BRIEF_RECEIVED" });
      return (await store.getMission(mission.id)) ?? mission;
    },

    async list(ownerId) {
      return (await store.listMissions(ownerId)).map(summary);
    },

    async detail(missionId) {
      const mission = await requireMission(missionId);
      await links.hydrate(missionId);
      const revision = await store.getRevision(missionId);
      const released = mission.releasedRevision !== undefined ? await store.getRevision(missionId, mission.releasedRevision) : null;
      const pending = await broker.listPending(missionId);
      const consoles = CONSOLE_IDS.flatMap((id) => revision?.results.reports.filter((r) => r.console === id) ?? []);
      return {
        mission,
        ...(revision ? { revision: revisionSummary(revision) } : {}),
        ...(released ? { released: revisionSummary(released) } : {}),
        consoles,
        pendingApprovals: pending.map(view),
        agentBusy: runs.active(missionId) !== undefined,
      } satisfies MissionDetail;
    },

    async setMode(missionId, mode, actor) {
      const before = await requireMission(missionId);
      const mission = await store.updateMission(missionId, { mode });
      if (before.mode !== mode) {
        await store.appendEvent({ missionId, channel: actor.channel, actor, kind: "mode.changed", text: `Permission mode: ${before.mode} → ${mode}`, data: { from: before.mode, to: mode } });
      }
      return mission;
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
      let link = links.resolve(approvalId);
      const direct = link ? null : await broker.get(approvalId);
      if (!link && direct) {
        await links.hydrate(direct.missionId);
        link = links.forBroker(direct.id);
      }
      const brokerId = link?.brokerId ?? direct?.id;
      if (!brokerId) throw new ApprovalNotFoundError(approvalId);

      let request: ApprovalRequest;
      try {
        request = await broker.decide(brokerId, decision, actor);
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
        data: { approvalId: link?.approvalId ?? request.id, decision, status: request.status, action: request.action },
      });

      if (link && request.status !== "pending") {
        const { applied, ready } = await applyToHistory(link.missionId, link.approvalId, request, actor);
        // First decision on an open chat approval, and nothing else open in that message: resume exactly once.
        if (applied && ready && !runs.active(link.missionId)) {
          await runs.start(link.missionId, { actor: { ...actor } });
        }
      }
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
      const state: BuildState = {
        missionId,
        ...(revision ? { revision: revision.n } : {}),
        ...(revision?.results.layout ? { layout: revision.results.layout } : {}),
        steps: steps.map((s) => ({
          ...s,
          ...(revision && revision.results.artifacts[`step-${s.n}.png`] ? { imageUrl: artifactUrl(missionId, revision.n, `step-${s.n}.png`) } : {}),
          ...(revision && revision.results.artifacts[`step-${s.n}-focus.png`] ? { focusImageUrl: artifactUrl(missionId, revision.n, `step-${s.n}-focus.png`) } : {}),
        })),
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
