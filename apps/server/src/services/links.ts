import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

interface LinkRow {
  userId: string;
  handle: string | null;
  expiresAt: number;
  redeemedAt: number | null;
}

export interface LinkService {
  createCode(userId: string): Promise<{ code: string; expiresAt: string }>;
  redeem(code: string, handle: string): Promise<{ userId: string } | null>;
  userForHandle(handle: string): Promise<string | null>;
  handleForUser(userId: string): Promise<string | null>;
}

export interface LinkServiceDependencies {
  db: DB;
  sqlite: SqliteDatabase;
}

export class SqlLinkService implements LinkService {
  constructor(private readonly deps: LinkServiceDependencies) {}

  async createCode(userId: string): Promise<{ code: string; expiresAt: string }> {
    const code = `VB-${randomBytes(5).toString("hex").toUpperCase()}`;
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.deps.sqlite
      .prepare('INSERT INTO "imessage_links" ("id", "userId", "codeHash", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, createHash("sha256").update(code).digest("hex"), Date.now(), expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async redeem(code: string, handle: string): Promise<{ userId: string } | null> {
    const hash = createHash("sha256").update(code.trim()).digest("hex");
    const now = Date.now();
    const transaction = this.deps.sqlite.transaction(() => {
      const row = this.deps.sqlite
        .prepare('SELECT "id", "userId", "handle", "expiresAt", "redeemedAt" FROM "imessage_links" WHERE "codeHash" = ?')
        .get(hash) as (LinkRow & { id: string }) | undefined;
      if (!row || row.redeemedAt !== null || row.expiresAt <= now) return null;
      const existing = this.deps.sqlite
        .prepare('SELECT "userId" FROM "imessage_links" WHERE "handle" = ? AND "redeemedAt" IS NOT NULL')
        .get(handle) as { userId: string } | undefined;
      if (existing && existing.userId !== row.userId) return null;
      const result = this.deps.sqlite
        .prepare('UPDATE "imessage_links" SET "handle" = ?, "redeemedAt" = ? WHERE "id" = ? AND "redeemedAt" IS NULL')
        .run(handle, now, row.id);
      return result.changes === 1 ? { userId: row.userId } : null;
    });
    return transaction();
  }

  async userForHandle(handle: string): Promise<string | null> {
    const row = this.deps.sqlite
      .prepare('SELECT "userId" FROM "imessage_links" WHERE "handle" = ? AND "redeemedAt" IS NOT NULL ORDER BY "redeemedAt" DESC LIMIT 1')
      .get(handle) as { userId: string } | undefined;
    return row?.userId ?? null;
  }

  async handleForUser(userId: string): Promise<string | null> {
    const row = this.deps.sqlite
      .prepare('SELECT "handle" FROM "imessage_links" WHERE "userId" = ? AND "redeemedAt" IS NOT NULL AND "handle" IS NOT NULL ORDER BY "redeemedAt" DESC LIMIT 1')
      .get(userId) as { handle: string | null } | undefined;
    return row?.handle ?? null;
  }
}

export function createLinkService(deps: LinkServiceDependencies): LinkService {
  return new SqlLinkService(deps);
}
