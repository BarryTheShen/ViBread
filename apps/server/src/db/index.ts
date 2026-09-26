import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { dbSchema, type DB } from "./schema.js";

export { dbSchema };
export type { DB };

export interface OpenDatabase {
  db: DB;
  sqlite: SqliteDatabase;
  close(): void;
}

export function openDatabase(dataDir: string): OpenDatabase {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, "vibread.sqlite"));
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema: dbSchema }) as BetterSQLite3Database<typeof dbSchema>;
  const migrationsFolder = join(dirname(new URL(import.meta.url).pathname), "../../drizzle");
  migrate(db, { migrationsFolder });
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
