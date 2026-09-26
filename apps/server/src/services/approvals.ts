import { randomUUID } from "node:crypto";
import type {
  ActionClass,
  Actor,
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
} from "@vibread/core";
import { hashJson, policyFor } from "@vibread/core";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { MissionStore } from "@vibread/core";
import type { DB } from "../db/schema.js";

interface ApprovalRow {
  id: string;
  missionId: string;
  revisionHash: string;
  actionClass: string;
  action: string;
  actionHash: string;
  summary: string;
  consequence: string;
  requestedBy: string;
  createdAt: number;
  expiresAt: number;
  status: string;
  decision: string | null;
  decidedBy: string | null;
  preApprovedBy: string | null;
  consumedAt: number | null;
}

export interface ApprovalBrokerDependencies {
  db: DB;
  sqlite: SqliteDatabase;
  approvalSecret?: string;
  store?: MissionStore;
}

export class SqlApprovalBroker implements ApprovalBroker {
  constructor(private readonly deps: ApprovalBrokerDependencies) {}

  async evaluate(input: {
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
  }): Promise<{ outcome: "approved" | "denied" | "user-approval" | "bench-click"; request?: ApprovalRequest; reason?: string }> {
    const outcome = policyFor(input.mode, input.actionClass, { allGo: input.allGo });
    if (outcome === "approved") return { outcome };
    if (outcome === "denied") return { outcome, reason: "permission mode denies state-changing actions" };
    const grantable = input.actionClass === "state-changing" || input.actionClass === "release";
    if (grantable) {
      const grant = this.deps.sqlite
        .prepare('SELECT "missionId" FROM "approval_grants" WHERE "missionId" = ? AND "actionClass" = ? AND "action" = ? AND "mode" = ?')
        .get(input.missionId, input.actionClass, input.action, input.mode) as { missionId: string } | undefined;
      if (grant) return { outcome: "approved" };
    }
    const actionHash = hashJson({ revisionHash: input.revisionHash, action: input.action, input: input.input });
    this.deps.sqlite
      .prepare('UPDATE "approvals" SET "status" = ? WHERE "missionId" = ? AND "status" = ? AND "expiresAt" <= ?')
      .run("expired", input.missionId, "pending", Date.now());
    const existing = this.deps.sqlite
      .prepare('SELECT * FROM "approvals" WHERE "missionId" = ? AND "revisionHash" = ? AND "actionHash" = ? AND "status" = ? ORDER BY "createdAt" DESC LIMIT 1')
      .get(input.missionId, input.revisionHash, actionHash, "pending") as ApprovalRow | undefined;
    if (existing) return { outcome, request: this.toRequest(existing) };
    const now = Date.now();
    const row: ApprovalRow = {
      id: randomUUID(),
      missionId: input.missionId,
      revisionHash: input.revisionHash,
      actionClass: input.actionClass,
      action: input.action,
      actionHash,
      summary: input.summary,
      consequence: input.consequence,
      requestedBy: JSON.stringify(input.actor),
      createdAt: now,
      expiresAt: now + 15 * 60 * 1000,
      status: "pending",
      decision: null,
      decidedBy: null,
      preApprovedBy: null,
      consumedAt: null,
    };
    this.deps.sqlite
      .prepare(
        'INSERT INTO "approvals" ("id", "missionId", "revisionHash", "actionClass", "action", "actionHash", "input", "summary", "consequence", "requestedBy", "createdAt", "expiresAt", "status", "decision", "decidedBy", "preApprovedBy", "consumedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.missionId,
        row.revisionHash,
        row.actionClass,
        row.action,
        row.actionHash,
        JSON.stringify(input.input),
        row.summary,
        row.consequence,
        row.requestedBy,
        row.createdAt,
        row.expiresAt,
        row.status,
        row.decision,
        row.decidedBy,
        row.preApprovedBy,
        row.consumedAt,
      );
    const request = this.toRequest(row);
    if (this.deps.store) {
      await this.deps.store.appendEvent({
        missionId: row.missionId,
        channel: input.actor.channel,
        actor: input.actor,
        kind: "approval.requested",
        text: row.summary,
        data: { approval: request },
      });
    }
    return { outcome, request };
  }

  async decide(approvalId: string, decision: ApprovalDecision, decider: Actor): Promise<ApprovalRequest> {
    if (decider.kind === "agent" || decider.channel === "mcp" || decider.channel === "a2a") {
      throw new Error("remote actors cannot decide approvals");
    }
    const row = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow | undefined;
    if (!row) throw new Error("approval not found");
    if (row.status === "pending" && row.expiresAt <= Date.now()) {
      this.deps.sqlite.prepare('UPDATE "approvals" SET "status" = ? WHERE "id" = ? AND "status" = ?').run("expired", approvalId, "pending");
      const expired = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow;
      return this.toRequest(expired);
    }
    if (row.status !== "pending") return this.toRequest(row);
    const decidedBy = JSON.stringify(decider);
    const approved = decision !== "deny";
    const preApprovedBy = row.actionClass === "physical" && decider.channel === "imessage" && approved ? decidedBy : null;
    if (decision === "approve-mission" && approved && (row.actionClass === "state-changing" || row.actionClass === "release")) {
      const mission = this.deps.sqlite.prepare('SELECT "mode" FROM "missions" WHERE "id" = ?').get(row.missionId) as { mode: PermissionMode } | undefined;
      if (mission) {
        this.deps.sqlite
          .prepare('INSERT INTO "approval_grants" ("missionId", "actionClass", "action", "mode", "createdAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT("missionId", "actionClass", "action") DO UPDATE SET "mode" = excluded."mode", "createdAt" = excluded."createdAt"')
          .run(row.missionId, row.actionClass, row.action, mission.mode, Date.now());
      }
    }
    this.deps.sqlite
      .prepare('UPDATE "approvals" SET "status" = ?, "decision" = ?, "decidedBy" = ?, "preApprovedBy" = ? WHERE "id" = ? AND "status" = ?')
      .run(approved ? "approved" : "denied", decision, decidedBy, preApprovedBy, approvalId, "pending");
    const updated = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow;
    return this.toRequest(updated);
  }

  async get(approvalId: string): Promise<ApprovalRequest | null> {
    const row = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow | undefined;
    if (!row) return null;
    if (row.status === "pending" && row.expiresAt <= Date.now()) {
      this.deps.sqlite.prepare('UPDATE "approvals" SET "status" = ? WHERE "id" = ? AND "status" = ?').run("expired", approvalId, "pending");
      const expired = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow;
      return this.toRequest(expired);
    }
    return this.toRequest(row);
  }

  async listPending(missionId: string): Promise<ApprovalRequest[]> {
    this.deps.sqlite
      .prepare('UPDATE "approvals" SET "status" = ? WHERE "missionId" = ? AND "status" = ? AND "expiresAt" <= ?')
      .run("expired", missionId, "pending", Date.now());
    const rows = this.deps.sqlite
      .prepare('SELECT * FROM "approvals" WHERE "missionId" = ? AND "status" = ? ORDER BY "createdAt"')
      .all(missionId, "pending") as ApprovalRow[];
    return rows.map((row) => this.toRequest(row));
  }

  async consume(approvalId: string, actionHash: string): Promise<boolean> {
    const row = this.deps.sqlite.prepare('SELECT * FROM "approvals" WHERE "id" = ?').get(approvalId) as ApprovalRow | undefined;
    if (!row || row.actionHash !== actionHash || row.actionClass === "physical") return false;
    if (row.expiresAt <= Date.now()) {
      this.deps.sqlite.prepare('UPDATE "approvals" SET "status" = ? WHERE "id" = ? AND "status" = ?').run("expired", approvalId, "approved");
      return false;
    }
    const result = this.deps.sqlite
      .prepare('UPDATE "approvals" SET "status" = ?, "consumedAt" = ? WHERE "id" = ? AND "status" = ? AND "actionHash" = ?')
      .run("consumed", Date.now(), approvalId, "approved", actionHash);
    return result.changes === 1;
  }

  private toRequest(row: ApprovalRow): ApprovalRequest {
    return {
      id: row.id,
      missionId: row.missionId,
      revisionHash: row.revisionHash,
      actionClass: row.actionClass as ActionClass,
      action: row.action,
      actionHash: row.actionHash,
      summary: row.summary,
      consequence: row.consequence,
      requestedBy: JSON.parse(row.requestedBy) as Actor,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      status: row.status as ApprovalRequest["status"],
      decision: row.decision === null ? undefined : (row.decision as ApprovalDecision),
      decidedBy: row.decidedBy === null ? undefined : (JSON.parse(row.decidedBy) as Actor),
      preApprovedBy: row.preApprovedBy === null ? undefined : (JSON.parse(row.preApprovedBy) as Actor),
    };
  }
}

export function createApprovalBroker(deps: ApprovalBrokerDependencies): ApprovalBroker {
  return new SqlApprovalBroker(deps);
}
