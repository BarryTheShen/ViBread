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
 *   PATCH  /api/missions/:id              { title }             → MissionSummary
 *   GET    /api/missions/:id/timeline?after=<eventId>           → TimelineEvent[]
 *   GET    /api/missions/:id/revisions                          → RevisionSummary[]
 *   GET    /api/missions/:id/revisions/:n                       → RevisionDetail
 *   GET    /api/missions/:id/revisions/:n/artifacts/:key        → raw artifact (schematic.svg, step-3.png, bench.hex …)
 *   GET    /api/missions/:id/chat                               → UI messages (AI SDK UIMessage[])
 *   POST   /api/missions/:id/chat         { message: UIMessage } → AI SDK UI message stream (SSE)
 *   GET    /api/missions/:id/chat/stream                        → resume the active stream (204 if none)
 *   POST   /api/missions/:id/chat/stop                          → { ok: true }
 *   POST   /api/approvals/:approvalId     { decision }          → ApprovalView (bench requests only)
 *   POST   /api/missions/:id/release      ReleaseRequest        → MissionDetail (the person's "GO for build"; 409 not_all_go | tests_missing | retro_missing | retro_no_go)
 *   GET    /api/missions/:id/build                              → BuildState   (phone Build Mode polls every 1–2 s)
 *   POST   /api/missions/:id/build/step   { n }                 → BuildState   ("I did this")
 *   POST   /api/missions/:id/bench/firmware { kind }            → BenchFirmwareResponse  kind: "bench" | "app"
 *   POST   /api/missions/:id/bench/runs   BenchRunRequest       → BenchRunResult
 *   POST   /api/missions/:id/photo        multipart photo + step → PhotoCheckResult
 *   GET    /api/connections                                     → ConnectionsView
 *   POST   /api/connections/tokens        { scopes, ttlMinutes } → TokenMintResponse
 *   DELETE /api/connections/tokens/:id                          → { ok: true }
 *   POST   /api/connections/imessage/code                       → ImessageLinkCode
 *   POST   /api/connections/claude/start                        → ClaudeLoginStart   (PLAN item 16: connect your Claude account)
 *   POST   /api/connections/claude/complete { loginId, code }   → ClaudeAccountView  (code = pasted code or final redirect URL)
 *   POST   /api/connections/claude/cancel { loginId }           → ClaudeAccountView
 *   DELETE /api/connections/claude                              → ClaudeAccountView
 *   /api/auth/*                                                 → Better Auth
 *   /mcp                                                        → MCP Streamable HTTP (bearer)
 *   /a2a, /.well-known/agent-card.json                          → A2A (bearer)
 */

export interface ApiError {
  /** `retryAt` (ISO time) is set when the request can be retried later, e.g. Claude rate limits. */
  error: { code: string; message: string; retryAt?: string };
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
  /**
   * Explicit parts (older clients, MCP/A2A callers). When omitted, the server copies the owner's ready inventory
   * entries into the mission (all of them, or only `inventoryEntryIds`) through each part type's mapping.
   */
  inventory?: InventoryItem[];
  inventoryEntryIds?: string[];
  title?: string;
}

export interface MissionSummary {
  id: string;
  title: string;
  brief: string;
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
  /** Present when this mission is a replay of a recorded real-model run (PLAN §4 named fallback), never a live one. */
  recording?: MissionRecording;
}

/**
 * A pre-warmed mission built from real model output captured earlier. Chat messages from it carry
 * `metadata.vibread.recorded: { label, model, recordedAt }`; a recorded RETRO vote carries
 * `ConsoleReport.evidence.recorded` with the same fields.
 */
export interface MissionRecording {
  /** Header text, e.g. "Recording of a real Claude run (Sep 26) — not live". */
  label: string;
  recordedOn: string;
  /** Role → model name, e.g. { design: "Claude Opus 5.5", testAuthor: "Claude Sonnet 5", retro: "Claude Sonnet 5" }. */
  models: Record<string, string>;
  provenance: string;
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
  fallbackUpload: { command: string; args: string[] };
}

/**
 * Human release of a revision as the build target (the Flight Director's GO). Every deterministic console must be GO;
 * RETRO must be GO unless it could not run (Claude not connected), in which case `acknowledgeMissingReview` must be true.
 */
export interface ReleaseRequest {
  revision: number;
  acknowledgeMissingReview?: boolean;
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
export interface BenchFirmwareResponse {
  hex: string;
  design: string;
  plan?: SelfTestPlan;
  fallbackUpload: { command: string; args: string[] };
}


export interface ConnectionsView {
  imessage: { linked: boolean; handle?: string; capcomNumber?: string };
  claudeCode: { tokens: { id: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt?: string }[] };
  /** MCP endpoint to paste into `claude mcp add`. */
  mcpUrl: string;
  phoneUrl: string;
  claude: ClaudeAccountView;
}

/**
 * PLAN item 16: the user's own Claude account (or API key) powering their missions — pi-ai's Anthropic sign-in or a
 * key saved with POST /api/connections/claude/key {key}, stored per user by the server.
 */
export interface ClaudeAccountView {
  connected: boolean;
  email?: string;
  orgName?: string;
  connectedAt?: string;
  /** A sign-in this user started that is waiting for the pasted code (or the local callback). */
  pending?: { loginId: string; url: string; startedAt: string };
  /** What powers this user's agents: their Claude account, their own API key, ViBread's server key, or nothing yet. */
  using: "claude-account" | "api-key" | "server-key" | "none";
  /** Only for `api-key`: false when the key was saved without Anthropic confirming it (e.g. offline). */
  verified?: boolean;
}

export interface ClaudeLoginStart {
  loginId: string;
  /** claude.ai sign-in page to open in a new tab. Finish with the pasted code, `code#state`, or the whole localhost callback address. */
  url: string;
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
