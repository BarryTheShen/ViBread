import type { z } from "zod";
import type { Circuit } from "./circuit.js";
import type {
  ActionClass,
  Actor,
  ApprovalDecision,
  ApprovalRequest,
  InventoryItem,
  Mission,
  PermissionMode,
  Revision,
  RevisionResults,
  TimelineEvent,
} from "./mission.js";
import type { TestSuite } from "./scenario.js";
import type { ApprovalView, BuildState, MissionDetail, MissionSummary } from "./api.js";

/**
 * Tool contract (packages/tools). Each tool is defined once and adapted to AI SDK tools (our agents) and MCP tools (/mcp).
 * Names are snake_case and stable; they are part of the public MCP surface.
 */
export interface ToolContext {
  missionId: string;
  actor: Actor;
  mode: PermissionMode;
  signal?: AbortSignal;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  title: string;
  description: string;
  actionClass: ActionClass;
  input: z.ZodType<I>;
  handler: (ctx: ToolContext, input: I) => Promise<O>;
}

export interface ToolRegistry {
  list(): ToolDef[];
  get(name: string): ToolDef | undefined;
}

/** Persistence (apps/server implements it on Drizzle + better-sqlite3). */
export interface MissionStore {
  createMission(input: {
    title: string;
    brief: string;
    ownerId: string;
    inventory: InventoryItem[];
    /** List-only parts the owner has, as text lines for the design agent (Mission.inventoryNotes). */
    inventoryNotes?: string[];
    mode: PermissionMode;
  }): Promise<Mission>;
  getMission(id: string): Promise<Mission | null>;
  listMissions(ownerId: string): Promise<Mission[]>;
  updateMission(id: string, patch: Partial<Pick<Mission, "title" | "mode" | "phase" | "currentRevision" | "releasedRevision" | "inventory">>): Promise<Mission>;
  /** Assigns n = latest + 1 and the revision hash. */
  createRevision(missionId: string, input: { circuit: Circuit; suite?: TestSuite; author: Actor; note?: string; parent?: number }): Promise<Revision>;
  /** Latest revision when `n` is omitted. */
  getRevision(missionId: string, n?: number): Promise<Revision | null>;
  listRevisions(missionId: string): Promise<Revision[]>;
  saveResults(missionId: string, n: number, patch: Partial<RevisionResults>): Promise<Revision>;
  /** Content-addressed blobs; returns the sha256 hex of the bytes. */
  putArtifact(data: Uint8Array | string, contentType: string): Promise<string>;
  getArtifact(hash: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  appendEvent(event: Omit<TimelineEvent, "id" | "at">): Promise<TimelineEvent>;
  listEvents(missionId: string, afterId?: string): Promise<TimelineEvent[]>;
  /** Change feed: called after every appendEvent commit (all missions). Returns an unsubscribe function. */
  subscribe(listener: (event: TimelineEvent) => void): () => void;
}

/** The authority for every approval (PLAN §5.10). UI/iMessage decisions are requests; the broker decides. */
export interface ApprovalBroker {
  /** Applies policyFor(mode, actionClass); creates a pending request when the outcome needs a human. */
  evaluate(input: {
    missionId: string;
    mode: PermissionMode;
    actionClass: ActionClass;
    action: string;
    input: unknown;
    revisionHash: string;
    actor: Actor;
    summary: string;
    consequence: string;
    allGo?: boolean;
  }): Promise<{ outcome: "approved" | "denied" | "user-approval" | "bench-click"; request?: ApprovalRequest; reason?: string }>;
  /** First valid decision wins. Physical actions: an iMessage "GO" becomes `preApprovedBy`, never execution. */
  decide(approvalId: string, decision: ApprovalDecision, decider: Actor): Promise<ApprovalRequest>;
  get(approvalId: string): Promise<ApprovalRequest | null>;
  listPending(missionId: string): Promise<ApprovalRequest[]>;
  /** One-shot: marks an approved request consumed if `actionHash` matches and it has not expired. */
  consume(approvalId: string, actionHash: string): Promise<boolean>;
}

/** What a non-streaming channel (iMessage, MCP, A2A) gets back from one agent turn. */
export interface AgentTurnResult {
  text: string;
  /** The agent is waiting for an answer from the user (ask-back). */
  question?: string;
  pendingApprovals: ApprovalView[];
  revision?: number;
}

/** Server facade used by the REST routes, CAPCOM (iMessage), /mcp, and /a2a. Implemented in apps/server. */
export interface MissionService {
  /**
   * Explicit `inventory` wins; when omitted, the owner's ready inventory entries (all, or only `inventoryEntryIds`) are
   * copied in through each part type's mapping (CreateMissionRequest in api.ts).
   */
  create(input: {
    brief: string;
    inventory?: InventoryItem[];
    inventoryEntryIds?: string[];
    mode?: PermissionMode;
    owner: Actor;
    title?: string;
  }): Promise<Mission>;
  list(ownerId: string): Promise<MissionSummary[]>;
  detail(missionId: string): Promise<MissionDetail>;
  setMode(missionId: string, mode: PermissionMode, actor: Actor): Promise<Mission>;
  /** Runs one design-agent turn to completion for a non-streaming channel. */
  say(missionId: string, text: string, actor: Actor): Promise<AgentTurnResult>;
  decide(approvalId: string, decision: ApprovalDecision, actor: Actor): Promise<ApprovalView>;
  build(missionId: string): Promise<BuildState>;
  events(missionId: string, afterId?: string): Promise<TimelineEvent[]>;
  /** Live timeline for push channels; returns an unsubscribe function. "*" = all missions. */
  subscribe(missionId: string | "*", listener: (event: TimelineEvent) => void): () => void;
}
