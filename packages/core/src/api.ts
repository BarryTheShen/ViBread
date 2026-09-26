import type { ConsoleReport } from "./consoles.js";
import type { Circuit } from "./circuit.js";
import type { Layout, LvsResult } from "./layout.js";
import type {
  ActionClass,
  Actor,
  ApprovalDecision,
  InventoryItem,
  Mission,
  MissionPhase,
  PermissionMode,
  RevisionResults,
  TimelineEvent,
} from "./mission.js";
import type { ModuleKey } from "./modules.js";
import type { BenchRunResult, PhotoCheckResult } from "./results.js";
import type { TestSuite } from "./scenario.js";
import type { SelfTestPlan } from "./selftest.js";
import type { Step } from "./steps.js";
import type { DeviceLine } from "./telemetry.js";

/**
 * REST contract between apps/web (and CAPCOM/MCP where noted) and apps/server. All JSON; errors are
 * `{ error: { code, message } }` with a 4xx/5xx status. Session cookie (Better Auth) or single-operator mode.
 *
 *   GET    /api/me                                              → MeResponse
 *   GET    /api/modules                                         → ModuleSummary[]
 *   GET    /api/missions                                        → MissionSummary[]
 *   POST   /api/missions                  CreateMissionRequest  → MissionSummary
 *   GET    /api/missions/:id                                    → MissionDetail
 *   PATCH  /api/missions/:id              { mode }              → MissionSummary
 *   GET    /api/missions/:id/timeline?after=<eventId>           → TimelineEvent[]
 *   GET    /api/missions/:id/revisions                          → RevisionSummary[]
 *   GET    /api/missions/:id/revisions/:n                       → RevisionDetail
 *   GET    /api/missions/:id/revisions/:n/artifacts/:key        → raw artifact (schematic.svg, step-3.png, bench.hex …)
 *   GET    /api/missions/:id/chat                               → UI messages (AI SDK UIMessage[])
 *   POST   /api/missions/:id/chat         { message: UIMessage } → AI SDK UI message stream (SSE)
 *   GET    /api/missions/:id/chat/stream                        → resume the active stream (204 if none)
 *   POST   /api/missions/:id/chat/stop                          → { ok: true }
 *   POST   /api/approvals/:approvalId     { decision }          → ApprovalView
 *   GET    /api/missions/:id/build                              → BuildState   (phone Build Mode polls every 1–2 s)
 *   POST   /api/missions/:id/build/step   { n }                 → BuildState   ("I did this")
 *   POST   /api/missions/:id/bench/firmware { kind }            → { hex, design, plan? }  kind: "bench" | "app"
 *   POST   /api/missions/:id/bench/runs   BenchRunRequest       → BenchRunResult
 *   POST   /api/missions/:id/photo        multipart photo + step → PhotoCheckResult
 *   GET    /api/connections                                     → ConnectionsView
 *   POST   /api/connections/tokens        { scopes, ttlMinutes } → TokenMintResponse
 *   DELETE /api/connections/tokens/:id                          → { ok: true }
 *   POST   /api/connections/imessage/code                       → ImessageLinkCode
 *   /api/auth/*                                                 → Better Auth
 *   /mcp                                                        → MCP Streamable HTTP (bearer)
 *   /a2a, /.well-known/agent-card.json                          → A2A (bearer)
 */

export interface ApiError {
  error: { code: string; message: string };
}

export interface MeResponse {
  user: { id: string; name: string; email?: string; image?: string } | null;
  /** "single-operator" when Google sign-in is not configured (laptop-only / dev). */
  auth: "google" | "single-operator";
}

export interface ModuleSummary {
  key: ModuleKey;
  name: string;
  description: string;
  category: "output" | "input" | "passive";
}

export interface CreateMissionRequest {
  brief: string;
  inventory: InventoryItem[];
  mode?: PermissionMode;
  title?: string;
}

export interface MissionSummary {
  id: string;
  title: string;
  brief: string;
  mode: PermissionMode;
  phase: MissionPhase;
  currentRevision?: number;
  releasedRevision?: number;
  updatedAt: string;
}

export interface ApprovalView {
  id: string;
  missionId: string;
  actionClass: ActionClass;
  action: string;
  summary: string;
  consequence: string;
  revisionHash: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  requestedBy: Actor;
  decidedBy?: Actor;
  decision?: ApprovalDecision;
  preApprovedBy?: Actor;
  expiresAt: string;
}

export interface RevisionSummary {
  n: number;
  hash: string;
  note?: string;
  author: Actor;
  createdAt: string;
  verdicts: Record<string, ConsoleReport["verdict"]>;
}

export interface MissionDetail {
  mission: Mission;
  revision?: RevisionSummary;
  released?: RevisionSummary;
  consoles: ConsoleReport[];
  pendingApprovals: ApprovalView[];
  /** Agent run in progress (chat stream active). */
  agentBusy: boolean;
}

export interface RevisionDetail {
  n: number;
  hash: string;
  circuit: Circuit;
  suite?: TestSuite;
  results: RevisionResults;
  lvs?: LvsResult;
  /** URL paths for artifacts, keyed like RevisionResults.artifacts. */
  artifactUrls: Record<string, string>;
}

export interface BuildState {
  missionId: string;
  revision?: number;
  layout?: Layout;
  /** imageUrl = whole board (step-<n>.png); focusImageUrl = cropped around this step's new items (step-<n>-focus.png). */
  steps: (Step & { imageUrl?: string; focusImageUrl?: string })[];
  /** 1-based index of the step the builder is on. */
  current: number;
  plug: "unplugged" | "plugged";
  /** Last thing that happened, for the phone header ("Self-test passed", "Houston, we have a problem…"). */
  headline?: string;
  updatedAt: string;
}

export interface BenchRunRequest {
  revision: number;
  kind: BenchRunResult["kind"];
  plan: SelfTestPlan;
  /** Every decoded device line in order (invalid lines dropped). */
  lines: DeviceLine[];
  /** Answers the person gave to `ask` lines: ask id → value. */
  answers: Record<string, string>;
}

export interface ConnectionsView {
  imessage: { linked: boolean; handle?: string; capcomNumber?: string };
  claudeCode: { tokens: { id: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt?: string }[] };
  /** MCP endpoint to paste into `claude mcp add`. */
  mcpUrl: string;
}

export interface TokenMintResponse {
  id: string;
  token: string;
  expiresAt: string;
  scopes: string[];
  /** Ready-to-copy command: claude mcp add --transport http vibread <mcpUrl> --header "Authorization: Bearer <token>" */
  command: string;
}

export interface ImessageLinkCode {
  code: string;
  expiresAt: string;
  capcomNumber?: string;
  /** sms:/imessage: deep link with the code pre-filled (for a QR code). */
  link?: string;
}

export type { PhotoCheckResult, TimelineEvent };
