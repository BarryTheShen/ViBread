import type { Circuit } from "./circuit.js";
import type { ConsoleReport } from "./consoles.js";
import type { Layout } from "./layout.js";
import type { ModuleKey, ModulePin } from "./modules.js";
import type { BenchRunResult, CompileResult, PhotoCheckResult, SimRunResult } from "./results.js";
import type { TestSuite } from "./scenario.js";
import type { SelfTestPlan } from "./selftest.js";
import type { StepList } from "./steps.js";

export const MISSION_PHASES = ["BRIEF", "CLARIFY", "DESIGN", "GONOGO", "ASSEMBLE", "VERIFY", "DEBUG", "LAUNCH", "DONE"] as const;
export type MissionPhase = (typeof MISSION_PHASES)[number];

export const CHANNELS = ["web", "imessage", "mcp", "a2a", "system"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Actor {
  kind: "human" | "agent" | "system";
  id: string;
  name?: string;
  channel: Channel;
}

/** A part the user owns. `params` narrows the module (e.g. { color: "red" }, { ohms: 220 }). */
export interface InventoryItem {
  module: ModuleKey;
  count: number;
  params?: Record<string, unknown>;
  note?: string;
  /** The user's name for the part when it isn't the module's own ("Thermistor (modelled as light sensor)"). */
  label?: string;
  /** Generic parts copied from a user part type: the pins the design must use. */
  pinout?: ModulePin[];
}

export interface Mission {
  id: string;
  title: string;
  brief: string;
  ownerId: string;
  phase: MissionPhase;
  inventory: InventoryItem[];
  /** Parts the owner has that ViBread can't design with (list-only types), passed to the design agent as text. */
  inventoryNotes?: string[];
  /** Latest revision number (1-based), if any. */
  currentRevision?: number;
  /** Revision released as the build target (all checks GO and the person pressed GO for build). */
  releasedRevision?: number;
  createdAt: string;
  updatedAt: string;
}

/** Everything computed for one revision. Large blobs live in artifacts (content-addressed) and are referenced by key. */
export interface RevisionResults {
  reports: ConsoleReport[];
  compile?: Omit<CompileResult, "hex">;
  sim?: Omit<SimRunResult, "traces">;
  layout?: Layout;
  layoutHash?: string;
  steps?: StepList;
  selftest?: SelfTestPlan;
  bench?: BenchRunResult[];
  photos?: PhotoCheckResult[];
  /** Artifact keys → content hashes: "schematic.svg", "app.hex", "bench.hex", "step-3.svg", "step-3.png", "trace-T1.json". */
  artifacts: Record<string, string>;
}

export interface Revision {
  missionId: string;
  n: number;
  /** revisionHash(circuit, suite). */
  hash: string;
  parent?: number;
  circuit: Circuit;
  suite?: TestSuite;
  author: Actor;
  note?: string;
  createdAt: string;
  results: RevisionResults;
}

/** Action classes every tool carries. Only `physical` needs a person: it runs from a click at the bench. */
export const ACTION_CLASSES = ["read-only", "state-changing", "physical", "bom-change"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export type ApprovalDecision = "approve-once" | "approve-mission" | "deny";

/**
 * A physical bench request (flash, rail checkpoint, self-test). Never executed by an agent or remote client: the bench
 * browser holding the serial port runs it after a human click. A linked iMessage handle may pre-approve it.
 */
export interface ApprovalRequest {
  id: string;
  missionId: string;
  revisionHash: string;
  actionClass: ActionClass;
  /** The bench action: "flash-bench", "rail-checkpoint", "run-selftest", "flash-app". */
  action: string;
  /** hashJson({ revisionHash, action, input }) — a decision only applies to this exact action. */
  actionHash: string;
  /** Plain-language action + consequence for the approval card. */
  summary: string;
  consequence: string;
  requestedBy: Actor;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  decision?: ApprovalDecision;
  decidedBy?: Actor;
  /** Physical actions: a linked iMessage handle said "GO" ahead of the bench click. */
  preApprovedBy?: Actor;
}

export interface TimelineEvent {
  id: string;
  missionId: string;
  at: string;
  channel: Channel;
  actor: Actor;
  /** "mission.created", "revision.created", "console.report", "approval.requested", "approval.decided", "bench.run",
   *  "photo.checked", "phase.changed", "message", "build.step" … */
  kind: string;
  text: string;
  revision?: number;
  data?: unknown;
}
