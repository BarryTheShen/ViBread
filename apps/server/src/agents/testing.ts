import type { DebugArea, DebugLevel, DebugLog } from "../services/debug-log.js";
import { randomUUID } from "node:crypto";
import {
  hashJson,
  revisionHash,
  sha256Hex,
  type ApprovalBroker,
  type ApprovalRequest,
  type ClaudeAccountView,
  type InventoryEntry,
  type PartType,
  BUILT_IN_PART_TYPES,
  type Mission,
  type MissionPhase,
  type MissionStore,
  type Revision,
  type TimelineEvent,
} from "@vibread/core";
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Credential,
  type CredentialStore,
  type FauxResponseFactory,
  type JsonObject,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { UIMessage } from "ai";
import pino from "pino";
import type { ClaudeAccountService } from "../claude/accounts.js";
import { loadConfig } from "../config.js";
import type { AgentDeps, InventoryReader, MissionEvent, MissionMachine } from "./deps.js";
import type { AgentModels, ClaudeModel } from "./models.js";

/**
 * SQLite-free implementations of the server contracts plus scripted models, for agent tests. Semantics mirror
 * ServerCore's SQL store and broker.
 */
export function memoryStore(): MissionStore {
  const listeners = new Set<(event: TimelineEvent) => void>();
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
      for (const listener of listeners) listener(structuredClone(saved));
      return structuredClone(saved);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
    async requestBench(input) {
      const actionHash = hashJson({ revisionHash: input.revisionHash, action: input.action, input: input.input });
      // Mirrors ServerCore's broker: an identical pending or approved-and-unused bench request is returned instead.
      const existing = [...requests.values()].find(
        (r) => r.missionId === input.missionId && r.revisionHash === input.revisionHash && r.actionHash === actionHash && (r.status === "pending" || r.status === "approved"),
      );
      if (existing) return structuredClone(existing);
      const request: ApprovalRequest = {
        id: randomUUID(),
        missionId: input.missionId,
        revisionHash: input.revisionHash,
        actionClass: "physical",
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
      return structuredClone(request);
    },
    async decide(id, decision, decider) {
      if (decider.kind === "agent" || decider.channel === "mcp" || decider.channel === "a2a") throw new Error("remote actors cannot decide approvals");
      const r = requests.get(id);
      if (!r) throw new Error("approval not found");
      if (r.status !== "pending") return structuredClone(r);
      const next: ApprovalRequest = {
        ...r,
        status: decision === "deny" ? "denied" : "approved",
        decision,
        decidedBy: decider,
        ...(decision !== "deny" && decider.channel === "imessage" ? { preApprovedBy: decider } : {}),
      };
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

// ---------- scripted Claude models on pi-ai's faux provider ----------

/** One design-agent turn: text and/or tool calls. */
export type ScriptStep = { text?: string; toolCalls?: { name: string; input: Record<string, unknown>; id?: string }[] };

/** A scripted Claude model (bind it with mockModels) and every request it received, as pi transcripts. */
export interface ScriptedModel {
  model: Model<Api>;
  models: Models;
  requests: TranscriptContext[];
  /** The request options, in the same order (forced tool, effort, …). */
  requestOptions: (SimpleStreamOptions | undefined)[];
}

/** Requests a scripted model can answer before the faux queue runs dry (more than MAX_STEPS per run). */
const SCRIPT_CAPACITY = 64;

function scripted(id: string, answer: (context: TranscriptContext, index: number) => AssistantMessage): ScriptedModel {
  const faux = fauxProvider({ provider: `faux-${id}`, models: [{ id, input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: TranscriptContext[] = [];
  const requestOptions: (SimpleStreamOptions | undefined)[] = [];
  let index = 0;
  const next: FauxResponseFactory = (context, options) => {
    requests.push(context);
    requestOptions.push(options);
    return answer(context, index++);
  };
  faux.setResponses(Array.from({ length: SCRIPT_CAPACITY }, () => next));
  return { model: faux.getModel(), models, requests, requestOptions };
}

/**
 * Design-agent mock: each model request takes the next scripted turn (a function sees the request transcript, e.g. to
 * react to tool results). When the script runs out it answers with a short text.
 */
export function scriptedDesign(script: (ScriptStep | ((context: TranscriptContext) => ScriptStep))[]): ScriptedModel {
  return scripted("mock-design", (context, index) => {
    const entry = script[index];
    const step = typeof entry === "function" ? entry(context) : (entry ?? { text: "Done." });
    // Scripted inputs are JSON test fixtures (golden circuits etc.).
    const calls = (step.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.input as JsonObject, call.id ? { id: call.id } : undefined));
    return fauxAssistantMessage([...(step.text ? [fauxText(step.text)] : []), ...calls], { stopReason: calls.length ? "toolUse" : "stop" });
  });
}

/** Single-shot mock (test author, RETRO, photo check, scan): calls the request's answer tool with the next value. */
export function scriptedJson(values: unknown[] | ((context: TranscriptContext) => unknown)): ScriptedModel {
  return scripted("mock-fast", (context, index) => {
    const value = typeof values === "function" ? values(context) : values[Math.min(index, values.length - 1)];
    const [tool] = getCurrentTools(context.messages);
    return fauxAssistantMessage(fauxToolCall(tool?.name ?? "answer", value as JsonObject), { stopReason: "toolUse" });
  });
}

/** A scripted model as the runtime sees one, paid by the server key. Hand-built ClaudeModels pass through. */
function claudeModelOf(model: ScriptedModel | ClaudeModel): ClaudeModel {
  if (!("models" in model)) return model;
  const { models } = model;
  return {
    model: model.model,
    modelId: model.model.id,
    credential: { kind: "server-key" },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
    complete: (context, options) => models.complete(model.model, context, options),
  };
}

export function mockModels(design: ScriptedModel | ClaudeModel, fast: ScriptedModel | ClaudeModel): AgentModels {
  return { design: async () => claudeModelOf(design), fast: async () => claudeModelOf(fast) };
}

/**
 * ClaudeAccountService fake: `accounts` maps user id → the credential (and email) their connected account stored.
 * Users not in the map are "not connected", so the server key is the fallback.
 */
export function fakeClaudeAccounts(accounts: Record<string, { credential: Credential; email?: string }> = {}): ClaudeAccountService {
  const stores = new Map<string, CredentialStore>();
  const credentials = (userId: string): CredentialStore => {
    let store = stores.get(userId);
    if (!store) {
      const memory = new InMemoryCredentialStore();
      const account = accounts[userId];
      // Every access waits for the seed write (InMemoryCredentialStore reads don't wait for pending writes).
      const seeded = account ? memory.modify("anthropic", async () => account.credential) : Promise.resolve(undefined);
      store = {
        read: async (providerId, options) => (await seeded, memory.read(providerId, options)),
        list: async (options) => (await seeded, memory.list(options)),
        modify: async (providerId, fn, options) => (await seeded, memory.modify(providerId, fn, options)),
        delete: async (providerId, options) => (await seeded, memory.delete(providerId, options)),
      };
      stores.set(userId, store);
    }
    return store;
  };
  const view = async (userId: string): Promise<ClaudeAccountView> => {
    const account = accounts[userId];
    return account ? { connected: true, using: "claude-account", ...(account.email ? { email: account.email } : {}) } : { connected: false, using: "none" };
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("fakeClaudeAccounts: sign-in is not available in tests");
  };
  return { view, credentials, start: unsupported, complete: unsupported, cancel: unsupported, saveApiKey: unsupported, disconnect: view, async stop() {} };
}

export type RecordingDebugLog = DebugLog & { entries: { missionId: string | null; area: DebugArea; message: string; data?: unknown; level: DebugLevel }[] };

/** In-memory ctx.debug: keeps every entry as given (the file log's redaction/capping is ServerCore's, tested there). */
export function recordingDebugLog(): RecordingDebugLog {
  const entries: RecordingDebugLog["entries"] = [];
  return {
    entries,
    event(missionId, area, message, data, level = "info") {
      entries.push({ missionId, area, message, ...(data === undefined ? {} : { data }), level });
    },
    tail(missionId, count = 500) {
      return entries.filter((e) => e.missionId === missionId).slice(-count).map((e) => JSON.stringify(e));
    },
  };
}

export function testDeps(): AgentDeps & { broker: MemoryBroker; machine: RecordingMachine; debug: RecordingDebugLog } {
  const store = memoryStore();
  return {
    // Built by the server's own loadConfig from a fixed env, so the test config always has the current shape.
    config: loadConfig({
      PORT: "8802",
      HOST: "127.0.0.1",
      DATA_DIR: "/tmp/vb-agents/test-data",
      BETTER_AUTH_SECRET: "test-auth-secret-000000000000000000000000",
      VIBREAD_APPROVAL_SECRET: "test-approval-secret-0000000000000000000000",
      VIBREAD_MODEL: "mock-design",
      VIBREAD_FAST_MODEL: "mock-fast",
    }),
    log: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
    store,
    broker: memoryBroker(),
    machine: recordingMachine(store),
    messages: memoryMessages(),
    claudeAccounts: fakeClaudeAccounts(),
    inventory: memoryInventory(),
    debug: recordingDebugLog(),
  };
}

/** Inventory fake: per-owner entries; types = the built-in catalog plus per-owner extras. */
export function memoryInventory(seed: { entries?: Record<string, InventoryEntry[]>; types?: Record<string, PartType[]> } = {}): InventoryReader & {
  set(ownerId: string, entries: InventoryEntry[]): void;
} {
  const entries = new Map(Object.entries(seed.entries ?? {}));
  return {
    set: (ownerId, list) => void entries.set(ownerId, structuredClone(list)),
    async entries(ownerId) {
      return structuredClone(entries.get(ownerId) ?? []);
    },
    async types(ownerId) {
      return [...BUILT_IN_PART_TYPES, ...(seed.types?.[ownerId] ?? [])];
    },
  };
}
