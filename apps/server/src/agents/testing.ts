import { randomUUID } from "node:crypto";
import {
  hashJson,
  policyFor,
  revisionHash,
  sha256Hex,
  type ApprovalBroker,
  type ApprovalRequest,
  type Mission,
  type MissionPhase,
  type MissionStore,
  type Revision,
  type TimelineEvent,
} from "@vibread/core";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import pino from "pino";
import type { AgentDeps, MissionEvent, MissionMachine } from "./deps.js";
import type { AgentModels } from "./models.js";

/**
 * SQLite-free implementations of the server contracts plus AI SDK mock models, for agent tests and the scratch server
 * (apps/server/src/agents/scratch-server.ts). Semantics mirror ServerCore's SQL store and broker.
 */
export function memoryStore(): MissionStore {
  const missions = new Map<string, Mission>();
  const revisions = new Map<string, Revision[]>();
  const artifacts = new Map<string, { data: Uint8Array; contentType: string }>();
  const events: TimelineEvent[] = [];
  const now = () => new Date().toISOString();

  return {
    async createMission(input) {
      const mission: Mission = { id: randomUUID(), ...input, phase: "BRIEF", createdAt: now(), updatedAt: now() };
      missions.set(mission.id, mission);
      events.push({
        id: String(events.length + 1).padStart(8, "0"),
        at: now(),
        missionId: mission.id,
        channel: "system",
        actor: { kind: "system", id: "server", channel: "system" },
        kind: "mission.created",
        text: `Mission created: ${mission.title}`,
      });
      return structuredClone(mission);
    },
    async getMission(id) {
      const m = missions.get(id);
      return m ? structuredClone(m) : null;
    },
    async listMissions(ownerId) {
      return [...missions.values()].filter((m) => m.ownerId === ownerId).map((m) => structuredClone(m));
    },
    async updateMission(id, patch) {
      const m = missions.get(id);
      if (!m) throw new Error("mission not found");
      const next = { ...m, ...patch, updatedAt: now() };
      missions.set(id, next);
      return structuredClone(next);
    },
    async createRevision(missionId, input) {
      const list = revisions.get(missionId) ?? [];
      const revision: Revision = {
        missionId,
        n: (list.at(-1)?.n ?? 0) + 1,
        hash: revisionHash(input.circuit, input.suite),
        circuit: input.circuit,
        ...(input.suite ? { suite: input.suite } : {}),
        author: input.author,
        ...(input.note ? { note: input.note } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        createdAt: now(),
        results: { reports: [], artifacts: {} },
      };
      revisions.set(missionId, [...list, revision]);
      return structuredClone(revision);
    },
    async getRevision(missionId, n) {
      const list = revisions.get(missionId) ?? [];
      const r = n === undefined ? list.at(-1) : list.find((x) => x.n === n);
      return r ? structuredClone(r) : null;
    },
    async listRevisions(missionId) {
      return structuredClone(revisions.get(missionId) ?? []);
    },
    async saveResults(missionId, n, patch) {
      const list = revisions.get(missionId) ?? [];
      const index = list.findIndex((x) => x.n === n);
      if (index < 0) throw new Error("revision not found");
      const current = list[index]!;
      const next: Revision = { ...current, results: { ...current.results, ...patch, artifacts: { ...current.results.artifacts, ...(patch.artifacts ?? {}) } } };
      list[index] = next;
      return structuredClone(next);
    },
    async putArtifact(data, contentType) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const hash = sha256Hex(bytes);
      artifacts.set(hash, { data: bytes, contentType });
      return hash;
    },
    async getArtifact(hash) {
      return artifacts.get(hash) ?? null;
    },
    async appendEvent(event) {
      const saved: TimelineEvent = { ...event, id: String(events.length + 1).padStart(8, "0"), at: now() };
      events.push(saved);
      return structuredClone(saved);
    },
    async listEvents(missionId, afterId) {
      return events.filter((e) => e.missionId === missionId && (afterId === undefined || e.id > afterId)).map((e) => structuredClone(e));
    },
  };
}

export type MemoryBroker = ApprovalBroker & { all(): ApprovalRequest[] };

export function memoryBroker(): MemoryBroker {
  const requests = new Map<string, ApprovalRequest>();
  return {
    all: () => [...requests.values()],
    async evaluate(input) {
      const outcome = policyFor(input.mode, input.actionClass, { allGo: input.allGo });
      if (outcome === "approved") return { outcome };
      if (outcome === "denied") return { outcome, reason: "permission mode denies state-changing actions" };
      const actionHash = hashJson({ revisionHash: input.revisionHash, action: input.action, input: input.input });
      const existing = [...requests.values()].find((r) => r.missionId === input.missionId && r.actionHash === actionHash && r.status === "pending");
      if (existing) return { outcome, request: structuredClone(existing) };
      const request: ApprovalRequest = {
        id: randomUUID(),
        missionId: input.missionId,
        revisionHash: input.revisionHash,
        actionClass: input.actionClass,
        action: input.action,
        actionHash,
        summary: input.summary,
        consequence: input.consequence,
        requestedBy: input.actor,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        status: "pending",
      };
      requests.set(request.id, request);
      return { outcome, request: structuredClone(request) };
    },
    async decide(id, decision, decider) {
      if (decider.kind === "agent" || decider.channel === "mcp" || decider.channel === "a2a") throw new Error("remote actors cannot decide approvals");
      const r = requests.get(id);
      if (!r) throw new Error("approval not found");
      if (r.status !== "pending") return structuredClone(r);
      const next: ApprovalRequest = { ...r, status: decision === "deny" ? "denied" : "approved", decision, decidedBy: decider };
      requests.set(id, next);
      return structuredClone(next);
    },
    async get(id) {
      const r = requests.get(id);
      return r ? structuredClone(r) : null;
    },
    async listPending(missionId) {
      return [...requests.values()].filter((r) => r.missionId === missionId && r.status === "pending").map((r) => structuredClone(r));
    },
    async consume(id, actionHash) {
      const r = requests.get(id);
      if (!r || r.actionHash !== actionHash || r.actionClass === "physical" || r.status !== "approved") return false;
      requests.set(id, { ...r, status: "consumed" });
      return true;
    },
  };
}

export function memoryMessages(): AgentDeps["messages"] {
  const histories = new Map<string, UIMessage[]>();
  return {
    async list(missionId) {
      return structuredClone(histories.get(missionId) ?? []);
    },
    async save(missionId, messages) {
      histories.set(missionId, structuredClone(messages));
    },
  };
}

/** Records events; phase follows the happy path loosely (enough for tests and the scratch server). */
export type RecordingMachine = MissionMachine & { events: { missionId: string; event: MissionEvent }[] };

export function recordingMachine(store: MissionStore): RecordingMachine {
  const events: { missionId: string; event: MissionEvent }[] = [];
  const next: Partial<Record<MissionEvent["type"], MissionPhase>> = {
    BRIEF_RECEIVED: "BRIEF",
    NEEDS_CLARIFICATION: "CLARIFY",
    DESIGN_STARTED: "DESIGN",
    DESIGN_READY: "GONOGO",
    RELEASED: "ASSEMBLE",
    FIX_PROPOSED: "GONOGO",
  };
  return {
    events,
    async phase(missionId) {
      return (await store.getMission(missionId))?.phase ?? "BRIEF";
    },
    async send(missionId, event) {
      events.push({ missionId, event });
      const phase = next[event.type];
      if (phase) await store.updateMission(missionId, { phase });
      return phase ?? (await store.getMission(missionId))?.phase ?? "BRIEF";
    },
  };
}

// ---------- scripted AI SDK mock models ----------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** One model step: text and/or tool calls. */
export type ScriptStep = { text?: string; toolCalls?: { name: string; input: unknown; id?: string }[] };

/** Stream parts for one scripted step (what Claude would stream through @ai-sdk/anthropic). */
export function streamParts(step: ScriptStep): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (step.text) {
    parts.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: step.text }, { type: "text-end", id: "t1" });
  }
  for (const call of step.toolCalls ?? []) {
    const id = call.id ?? `call-${randomUUID().slice(0, 8)}`;
    const input = JSON.stringify(call.input);
    parts.push(
      { type: "tool-input-start", id, toolName: call.name },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-input-end", id },
      { type: "tool-call", toolCallId: id, toolName: call.name, input },
    );
  }
  parts.push({ type: "finish", finishReason: { unified: step.toolCalls?.length ? "tool-calls" : "stop", raw: undefined }, usage: USAGE });
  return parts;
}

/**
 * Design-agent mock: each doStream call takes the next scripted step (a function sees the call options, e.g. to react to
 * tool results). When the script runs out it answers with a short text.
 */
export function scriptedModel(script: (ScriptStep | ((options: LanguageModelV4CallOptions) => ScriptStep))[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    modelId: "mock-design",
    doStream: async (options) => {
      const entry = script[index++];
      const step = typeof entry === "function" ? entry(options) : (entry ?? { text: "Done." });
      return { stream: simulateReadableStream({ chunks: streamParts(step), chunkDelayInMs: 1 }) };
    },
  });
}

/** Structured-output mock: returns the next JSON value per doGenerate call (test author, RETRO, photo). */
export function jsonModel(values: unknown[] | ((options: LanguageModelV4CallOptions) => unknown)): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    modelId: "mock-fast",
    doGenerate: async (options) => {
      const value = typeof values === "function" ? values(options) : values[Math.min(index++, values.length - 1)];
      return { content: [{ type: "text", text: JSON.stringify(value) }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] };
    },
  });
}

export function mockModels(design: LanguageModelV4, fast: LanguageModelV4): AgentModels {
  return { design: () => design, fast: () => fast, designId: "mock-design", fastId: "mock-fast" };
}

export function testDeps(): AgentDeps & { broker: MemoryBroker; machine: RecordingMachine } {
  const store = memoryStore();
  return {
    config: {
      port: 0,
      host: "127.0.0.1",
      publicUrl: "http://localhost",
      dataDir: "/tmp/vb-agents/data",
      singleOperator: true,
      authSecret: "test-auth-secret-000000000000000000000000",
      model: "mock-design",
      fastModel: "mock-fast",
      approvalSecret: "test-approval-secret-0000000000000000000000",
      capcom: { provider: "off" },
    },
    log: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
    store,
    broker: memoryBroker(),
    machine: recordingMachine(store),
    messages: memoryMessages(),
  };
}
