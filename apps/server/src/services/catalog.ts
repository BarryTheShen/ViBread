import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { BUILT_IN_PART_TYPES, type CatalogView, type FieldValue, type PartType } from "@vibread/core";
import type { DB } from "../db/schema.js";

interface TypeRow { id: string; ownerId: string; json: string; }

export interface CatalogService {
  types(ownerId: string): Promise<PartType[]>;
  view(ownerId: string): Promise<CatalogView>;
  upsert(ownerId: string, input: PartType): Promise<PartType>;
  update(ownerId: string, id: string, patch: Partial<PartType>): Promise<PartType>;
  remove(ownerId: string, id: string, force?: boolean): Promise<void>;
  get(ownerId: string, id: string): Promise<PartType | null>;
}

export interface CatalogServiceDependencies { db: DB; sqlite: SqliteDatabase; }

export class SqlCatalogService implements CatalogService {
  constructor(private readonly deps: CatalogServiceDependencies) {}

  async types(ownerId: string): Promise<PartType[]> {
    const rows = this.deps.sqlite.prepare('SELECT "json" FROM "part_types" WHERE "ownerId" = ? ORDER BY "id"').all(ownerId) as Array<{ json: string }>;
    return [...BUILT_IN_PART_TYPES, ...rows.map((row) => JSON.parse(row.json) as PartType)];
  }

  async view(ownerId: string): Promise<CatalogView> { return { types: await this.types(ownerId) }; }

  async get(ownerId: string, id: string): Promise<PartType | null> {
    const builtIn = BUILT_IN_PART_TYPES.find((type) => type.id === id);
    if (builtIn) return builtIn;
    const row = this.deps.sqlite.prepare('SELECT "json" FROM "part_types" WHERE "id" = ? AND "ownerId" = ?').get(id, ownerId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as PartType : null;
  }

  async upsert(ownerId: string, input: PartType): Promise<PartType> {
    const type: PartType = { ...input, id: typeof input.id === "string" && input.id.startsWith("u-") ? input.id : `u-${randomUUID()}`, builtIn: false };
    this.deps.sqlite.prepare('INSERT INTO "part_types" ("id", "ownerId", "json", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT("id") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"').run(type.id, ownerId, JSON.stringify(type), Date.now(), Date.now());
    return type;
  }

  async update(ownerId: string, id: string, patch: Partial<PartType>): Promise<PartType> {
    const current = await this.get(ownerId, id);
    if (!current || current.builtIn) throw new Error("user part type not found");
    return this.upsert(ownerId, { ...current, ...patch, id, builtIn: false });
  }

  async remove(ownerId: string, id: string, force = false): Promise<void> {
    if (BUILT_IN_PART_TYPES.some((type) => type.id === id)) throw new Error("built-in part types cannot be deleted");
    const count = this.deps.sqlite.prepare('SELECT COUNT(*) AS count FROM "inventory_items" WHERE "ownerId" = ? AND "typeId" = ?').get(ownerId, id) as { count: number };
    if (count.count > 0 && !force) throw Object.assign(new Error("part type has inventory entries"), { status: 409, code: "TYPE_IN_USE" });
    this.deps.sqlite.prepare('DELETE FROM "part_types" WHERE "id" = ? AND "ownerId" = ?').run(id, ownerId);
    if (force) this.deps.sqlite.prepare('DELETE FROM "inventory_items" WHERE "ownerId" = ? AND "typeId" = ?').run(ownerId, id);
  }
}

export function createCatalogService(deps: CatalogServiceDependencies): CatalogService { return new SqlCatalogService(deps); }
