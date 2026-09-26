import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

export interface CapcomSpace {
  spaceId: string;
  handle: string;
  userId: string;
  missionId?: string;
  updatedAt: string;
}

export interface CapcomSpaceStore {
  get(spaceId: string): Promise<CapcomSpace | null>;
  put(input: { spaceId: string; handle: string; userId: string; missionId?: string | null }): Promise<CapcomSpace>;
  setMission(spaceId: string, missionId: string | null): Promise<CapcomSpace | null>;
  listForMission(missionId: string): Promise<CapcomSpace[]>;
}

interface CapcomSpaceRow {
  spaceId: string;
  handle: string;
  userId: string;
  missionId: string | null;
  updatedAt: number;
}

export interface CapcomSpaceStoreDependencies {
  db: DB;
  sqlite: SqliteDatabase;
}

export class SqlCapcomSpaceStore implements CapcomSpaceStore {
  constructor(private readonly deps: CapcomSpaceStoreDependencies) {}

  async get(spaceId: string): Promise<CapcomSpace | null> {
    const row = this.deps.sqlite.prepare('SELECT * FROM "capcom_spaces" WHERE "spaceId" = ?').get(spaceId) as CapcomSpaceRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  async put(input: { spaceId: string; handle: string; userId: string; missionId?: string | null }): Promise<CapcomSpace> {
    const now = Date.now();
    this.deps.sqlite
      .prepare('INSERT INTO "capcom_spaces" ("spaceId", "handle", "userId", "missionId", "updatedAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT("spaceId") DO UPDATE SET "handle" = excluded."handle", "userId" = excluded."userId", "missionId" = excluded."missionId", "updatedAt" = excluded."updatedAt"')
      .run(input.spaceId, input.handle, input.userId, input.missionId ?? null, now);
    const row = await this.get(input.spaceId);
    if (!row) throw new Error("CAPCOM space was not persisted");
    return row;
  }

  async setMission(spaceId: string, missionId: string | null): Promise<CapcomSpace | null> {
    this.deps.sqlite.prepare('UPDATE "capcom_spaces" SET "missionId" = ?, "updatedAt" = ? WHERE "spaceId" = ?').run(missionId, Date.now(), spaceId);
    return this.get(spaceId);
  }

  async listForMission(missionId: string): Promise<CapcomSpace[]> {
    const rows = this.deps.sqlite.prepare('SELECT * FROM "capcom_spaces" WHERE "missionId" = ? ORDER BY "updatedAt" DESC').all(missionId) as CapcomSpaceRow[];
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: CapcomSpaceRow): CapcomSpace {
    return {
      spaceId: row.spaceId,
      handle: row.handle,
      userId: row.userId,
      ...(row.missionId ? { missionId: row.missionId } : {}),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}

export function createCapcomSpaceStore(deps: CapcomSpaceStoreDependencies): CapcomSpaceStore {
  return new SqlCapcomSpaceStore(deps);
}
