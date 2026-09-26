import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
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
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema: dbSchema }) as BetterSQLite3Database<typeof dbSchema>;
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

function applyMigrations(sqlite: SqliteDatabase): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS "__vb_migrations" ("name" TEXT PRIMARY KEY NOT NULL, "appliedAt" INTEGER NOT NULL)',
  );
  const migrationDir = join(dirname(new URL(import.meta.url).pathname), "../../drizzle");
  let names: string[];
  try {
    names = readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch {
    names = [];
  }
  const applied = new Set(
    (sqlite.prepare('SELECT "name" FROM "__vb_migrations"').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationDir, name), "utf8");
    const apply = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO "__vb_migrations" ("name", "appliedAt") VALUES (?, ?)')
        .run(name, Date.now());
    });
    apply();
  }
}
