import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Actor,
  Circuit,
  InventoryItem,
  Mission,
  MissionStore,
  Revision,
  RevisionResults,
  TestSuite,
  TimelineEvent,
} from "@vibread/core";
import { revisionHash } from "@vibread/core";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

interface MissionRow {
  id: string;
  title: string;
  brief: string;
  ownerId: string;
  mode: string;
  phase: string;
  inventory: string;
  inventoryNotes: string | null;
  currentRevision: number | null;
  releasedRevision: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RevisionRow {
  missionId: string;
  n: number;
  hash: string;
  parent: number | null;
  circuit: string;
  suite: string | null;
  author: string;
  note: string | null;
  results: string;
  createdAt: number;
}

interface ArtifactRow {
  hash: string;
  contentType: string;
  path: string;
}

interface EventRow {
  id: string;
  missionId: string;
  at: number;
  channel: string;
  actor: string;
  kind: string;
  text: string;
  revision: number | null;
  data: string | null;
}

export interface MissionStoreDependencies {
  db: DB;
  sqlite: SqliteDatabase;
  dataDir: string;
}

export class SqlMissionStore implements MissionStore {
  private readonly artifactsDir: string;
  private readonly listeners = new Set<(event: TimelineEvent) => void>();
  constructor(private readonly deps: MissionStoreDependencies) {
    this.artifactsDir = join(deps.dataDir, "artifacts");
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  async createMission(input: {
    title: string;
    brief: string;
    ownerId: string;
    inventory: InventoryItem[];
    inventoryNotes?: string[];
  }): Promise<Mission> {
    const id = randomUUID();
    const now = Date.now();
    this.deps.sqlite
      .prepare(
        'INSERT INTO "missions" ("id", "title", "brief", "ownerId", "mode", "phase", "inventory", "inventoryNotes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      // "mode" is a legacy NOT NULL column (permission modes were removed); it holds a fixed value and is never read.
      .run(id, input.title, input.brief, input.ownerId, "none", "BRIEF", JSON.stringify(input.inventory), input.inventoryNotes ? JSON.stringify(input.inventoryNotes) : null, now, now);
    const mission = await this.getMission(id);
    if (!mission) throw new Error("mission was not persisted");
    await this.appendEvent({
      missionId: id,
      channel: "system",
      actor: { kind: "system", id: "server", channel: "system" },
      kind: "mission.created",
      text: `Mission ${mission.title} created`,
    });
    return mission;
  }

  async getMission(id: string): Promise<Mission | null> {
    const row = this.deps.sqlite.prepare('SELECT * FROM "missions" WHERE "id" = ?').get(id) as MissionRow | undefined;
    return row ? this.missionFromRow(row) : null;
  }

  async listMissions(ownerId: string): Promise<Mission[]> {
    const rows = this.deps.sqlite
      .prepare('SELECT * FROM "missions" WHERE "ownerId" = ? ORDER BY "updatedAt" DESC')
      .all(ownerId) as MissionRow[];
    return rows.map((row) => this.missionFromRow(row));
  }

  async updateMission(
    id: string,
    patch: Partial<Pick<Mission, "title" | "phase" | "currentRevision" | "releasedRevision" | "inventory">>,
  ): Promise<Mission> {
    const current = await this.getMission(id);
    if (!current) throw new Error("mission not found");
    const next = {
      title: patch.title ?? current.title,
      phase: patch.phase ?? current.phase,
      inventory: patch.inventory ?? current.inventory,
      currentRevision: patch.currentRevision ?? current.currentRevision ?? null,
      releasedRevision: patch.releasedRevision ?? current.releasedRevision ?? null,
    };
    const now = Date.now();
    this.deps.sqlite
      .prepare(
        'UPDATE "missions" SET "title" = ?, "phase" = ?, "inventory" = ?, "currentRevision" = ?, "releasedRevision" = ?, "updatedAt" = ? WHERE "id" = ?',
      )
      .run(next.title, next.phase, JSON.stringify(next.inventory), next.currentRevision, next.releasedRevision, now, id);
    const mission = await this.getMission(id);
    if (!mission) throw new Error("mission disappeared during update");
    if (next.phase !== current.phase) {
      await this.appendEvent({
        missionId: id,
        channel: "system",
        actor: { kind: "system", id: "server", channel: "system" },
        kind: "phase.changed",
        text: `${current.phase} → ${next.phase}`,
        revision: next.currentRevision ?? undefined,
      });
    }
    return mission;
  }

  async createRevision(
    missionId: string,
    input: { circuit: Circuit; suite?: TestSuite; author: Actor; note?: string; parent?: number },
  ): Promise<Revision> {
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("mission not found");
    const latest = this.deps.sqlite
      .prepare('SELECT MAX("n") AS n FROM "revisions" WHERE "missionId" = ?')
      .get(missionId) as { n: number | null };
    const n = (latest.n ?? 0) + 1;
    const hash = revisionHash(input.circuit, input.suite);
    const now = Date.now();
    const result: RevisionResults = { reports: [], artifacts: {} };
    this.deps.sqlite
      .prepare(
        'INSERT INTO "revisions" ("missionId", "n", "hash", "parent", "circuit", "suite", "author", "note", "results", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        missionId,
        n,
        hash,
        input.parent ?? (mission.currentRevision ?? null),
        JSON.stringify(input.circuit),
        input.suite === undefined ? null : JSON.stringify(input.suite),
        JSON.stringify(input.author),
        input.note ?? null,
        JSON.stringify(result),
        now,
      );
    await this.updateMission(missionId, { currentRevision: n });
    const revision = await this.getRevision(missionId, n);
    if (!revision) throw new Error("revision was not persisted");
    return revision;
  }

  async getRevision(missionId: string, n?: number): Promise<Revision | null> {
    const row = n === undefined
      ? (this.deps.sqlite.prepare('SELECT * FROM "revisions" WHERE "missionId" = ? ORDER BY "n" DESC LIMIT 1').get(missionId) as RevisionRow | undefined)
      : (this.deps.sqlite.prepare('SELECT * FROM "revisions" WHERE "missionId" = ? AND "n" = ?').get(missionId, n) as RevisionRow | undefined);
    return row ? this.revisionFromRow(row) : null;
  }

  async listRevisions(missionId: string): Promise<Revision[]> {
    const rows = this.deps.sqlite
      .prepare('SELECT * FROM "revisions" WHERE "missionId" = ? ORDER BY "n" DESC')
      .all(missionId) as RevisionRow[];
    return rows.map((row) => this.revisionFromRow(row));
  }

  async saveResults(missionId: string, n: number, patch: Partial<RevisionResults>): Promise<Revision> {
    const current = await this.getRevision(missionId, n);
    if (!current) throw new Error("revision not found");
    const results: RevisionResults = {
      ...current.results,
      ...patch,
      artifacts: { ...current.results.artifacts, ...(patch.artifacts ?? {}) },
    };
    this.deps.sqlite
      .prepare('UPDATE "revisions" SET "results" = ? WHERE "missionId" = ? AND "n" = ?')
      .run(JSON.stringify(results), missionId, n);
    const revision = await this.getRevision(missionId, n);
    if (!revision) throw new Error("revision disappeared during result save");
    return revision;
  }

  async putArtifact(data: Uint8Array | string, contentType: string): Promise<string> {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.deps.sqlite.prepare('SELECT "hash" FROM "artifacts" WHERE "hash" = ?').get(hash) as { hash: string } | undefined;
    if (existing) return hash;
    const path = join(this.artifactsDir, hash);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
    try {
      this.deps.sqlite
        .prepare('INSERT INTO "artifacts" ("hash", "contentType", "path", "size", "createdAt") VALUES (?, ?, ?, ?, ?)')
        .run(hash, contentType, path, bytes.byteLength, Date.now());
    } catch {
      // A concurrent writer already inserted this content-addressed row.
    }
    return hash;
  }

  async getArtifact(hash: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const row = this.deps.sqlite.prepare('SELECT "path", "contentType" FROM "artifacts" WHERE "hash" = ?').get(hash) as ArtifactRow | undefined;
    if (!row || !existsSync(row.path)) return null;
    return { data: new Uint8Array(readFileSync(row.path)), contentType: row.contentType };
  }

  async appendEvent(event: Omit<TimelineEvent, "id" | "at">): Promise<TimelineEvent> {
    const full: TimelineEvent = { ...event, id: randomUUID(), at: new Date().toISOString() };
    this.deps.sqlite
      .prepare(
        'INSERT INTO "events" ("id", "missionId", "at", "channel", "actor", "kind", "text", "revision", "data") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id,
        full.missionId,
        Date.parse(full.at),
        full.channel,
        JSON.stringify(full.actor),
        full.kind,
        full.text,
        full.revision ?? null,
        full.data === undefined ? null : JSON.stringify(full.data),
      );
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A change-feed consumer must not make a committed timeline write fail.
      }
    }
    return full;
  }
  subscribe(listener: (event: TimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listEvents(missionId: string, afterId?: string): Promise<TimelineEvent[]> {
    let rows: EventRow[];
    // Events written in the same millisecond (a copied or imported timeline, a burst of check reports) keep the order they
    // were written in: rowid, never the random event id, breaks ties.
    if (!afterId) {
      rows = this.deps.sqlite.prepare('SELECT * FROM "events" WHERE "missionId" = ? ORDER BY "at", rowid').all(missionId) as EventRow[];
    } else {
      const cursor = this.deps.sqlite.prepare('SELECT "at", rowid AS "seq" FROM "events" WHERE "id" = ? AND "missionId" = ?').get(afterId, missionId) as { at: number; seq: number } | undefined;
      if (!cursor) return [];
      rows = this.deps.sqlite
        .prepare('SELECT * FROM "events" WHERE "missionId" = ? AND ("at" > ? OR ("at" = ? AND rowid > ?)) ORDER BY "at", rowid')
        .all(missionId, cursor.at, cursor.at, cursor.seq) as EventRow[];
    }
    return rows.map((row) => ({
      id: row.id,
      missionId: row.missionId,
      at: new Date(row.at).toISOString(),
      channel: row.channel as TimelineEvent["channel"],
      actor: JSON.parse(row.actor) as Actor,
      kind: row.kind,
      text: row.text,
      revision: row.revision ?? undefined,
      data: row.data === null ? undefined : (JSON.parse(row.data) as unknown),
    }));
  }

  deleteMission(id: string): void {
    const remove = this.deps.sqlite.transaction(() => {
      this.deps.sqlite.prepare('DELETE FROM "events" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "approvals" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "approval_grants" WHERE "missionId" = ?').run(id);
      // CAPCOM: notices held for quiet hours about it are dropped, and conversations attached to it detach.
      this.deps.sqlite.prepare('DELETE FROM "capcom_queue" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('UPDATE "capcom_spaces" SET "missionId" = NULL WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "runs" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "messages" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "revisions" WHERE "missionId" = ?').run(id);
      this.deps.sqlite.prepare('DELETE FROM "missions" WHERE "id" = ?').run(id);
    });
    remove();
  }

  private missionFromRow(row: MissionRow): Mission {
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      ownerId: row.ownerId,
      phase: row.phase as Mission["phase"],
      inventory: JSON.parse(row.inventory) as InventoryItem[],
      ...(row.inventoryNotes ? { inventoryNotes: JSON.parse(row.inventoryNotes) as string[] } : {}),
      currentRevision: row.currentRevision ?? undefined,
      releasedRevision: row.releasedRevision ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private revisionFromRow(row: RevisionRow): Revision {
    return {
      missionId: row.missionId,
      n: row.n,
      hash: row.hash,
      parent: row.parent ?? undefined,
      circuit: JSON.parse(row.circuit) as Circuit,
      suite: row.suite === null ? undefined : (JSON.parse(row.suite) as TestSuite),
      author: JSON.parse(row.author) as Actor,
      note: row.note ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      results: JSON.parse(row.results) as RevisionResults,
    };
  }
}

export function createMissionStore(deps: MissionStoreDependencies): MissionStore {
  return new SqlMissionStore(deps);
}
