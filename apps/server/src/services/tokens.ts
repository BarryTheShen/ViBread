import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

interface TokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  scopes: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

export interface TokenService {
  mint(input: { userId: string; scopes: string[]; ttlMinutes: number }): Promise<{ id: string; token: string; expiresAt: string }>;
  verify(token: string): Promise<{ id: string; userId: string; scopes: string[]; expiresAt: string } | null>;
  list(userId: string): Promise<{ id: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt?: string }[]>;
  revoke(id: string, userId: string): Promise<void>;
}

export interface TokenServiceDependencies {
  db: DB;
  sqlite: SqliteDatabase;
}

export class SqlTokenService implements TokenService {
  constructor(private readonly deps: TokenServiceDependencies) {}

  async mint(input: { userId: string; scopes: string[]; ttlMinutes: number }): Promise<{ id: string; token: string; expiresAt: string }> {
    const ttl = Number.isFinite(input.ttlMinutes) ? Math.max(1, Math.min(24 * 60, Math.floor(input.ttlMinutes))) : 60;
    const token = `vb_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + ttl * 60 * 1000;
    this.deps.sqlite
      .prepare('INSERT INTO "api_tokens" ("id", "userId", "tokenHash", "scopes", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.userId, createHash("sha256").update(token).digest("hex"), JSON.stringify([...new Set(input.scopes)]), createdAt, expiresAt);
    return { id, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async verify(token: string): Promise<{ id: string; userId: string; scopes: string[]; expiresAt: string } | null> {
    if (!token.startsWith("vb_")) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    const row = this.deps.sqlite.prepare('SELECT * FROM "api_tokens" WHERE "tokenHash" = ?').get(hash) as TokenRow | undefined;
    if (!row || row.expiresAt <= Date.now()) return null;
    this.deps.sqlite.prepare('UPDATE "api_tokens" SET "lastUsedAt" = ? WHERE "id" = ?').run(Date.now(), row.id);
    return {
      id: row.id,
      userId: row.userId,
      scopes: JSON.parse(row.scopes) as string[],
      expiresAt: new Date(row.expiresAt).toISOString(),
    };
  }

  async list(userId: string): Promise<{ id: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt?: string }[]> {
    const rows = this.deps.sqlite.prepare('SELECT * FROM "api_tokens" WHERE "userId" = ? ORDER BY "createdAt" DESC').all(userId) as TokenRow[];
    return rows.map((row) => ({
      id: row.id,
      scopes: JSON.parse(row.scopes) as string[],
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      lastUsedAt: row.lastUsedAt === null ? undefined : new Date(row.lastUsedAt).toISOString(),
    }));
  }

  async revoke(id: string, userId: string): Promise<void> {
    this.deps.sqlite.prepare('DELETE FROM "api_tokens" WHERE "id" = ? AND "userId" = ?').run(id, userId);
  }
}

export function createTokenService(deps: TokenServiceDependencies): TokenService {
  return new SqlTokenService(deps);
}
