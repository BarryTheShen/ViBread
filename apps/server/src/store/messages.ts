import type { UIMessage } from "ai";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

export interface MessageStore {
  list(missionId: string): Promise<UIMessage[]>;
  save(missionId: string, messages: UIMessage[]): Promise<void>;
}

export interface MessageStoreDependencies {
  db: DB;
  sqlite: SqliteDatabase;
}

export class SqlMessageStore implements MessageStore {
  constructor(private readonly deps: MessageStoreDependencies) {}

  async list(missionId: string): Promise<UIMessage[]> {
    const row = this.deps.sqlite.prepare('SELECT "history" FROM "messages" WHERE "missionId" = ?').get(missionId) as { history: string } | undefined;
    if (!row) return [];
    return JSON.parse(row.history) as UIMessage[];
  }

  async save(missionId: string, messages: UIMessage[]): Promise<void> {
    const now = Date.now();
    this.deps.sqlite
      .prepare(
        'INSERT INTO "messages" ("missionId", "history", "updatedAt") VALUES (?, ?, ?) ON CONFLICT("missionId") DO UPDATE SET "history" = excluded."history", "updatedAt" = excluded."updatedAt"',
      )
      .run(missionId, JSON.stringify(messages), now);
  }
}

export function createMessageStore(deps: MessageStoreDependencies): MessageStore {
  return new SqlMessageStore(deps);
}
