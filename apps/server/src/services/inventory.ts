import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { inventoryIdentity, type EntrySource, type EntryStatus, type FieldValue, type InventoryEntry, type InventoryUpsertRequest, type InventoryView, type PartType, type MissionStore } from "@vibread/core";
import type { DB } from "../db/schema.js";
import type { CatalogService } from "./catalog.js";

interface ItemRow { id: string; ownerId: string; typeId: string; identity: string; values: string; quantity: number; status: string; source: string; candidates: string | null; photoUrl: string | null; note: string | null; createdAt: number; updatedAt: number; }

export interface InventoryService {
  entries(ownerId: string): Promise<InventoryEntry[]>;
  types(ownerId: string): Promise<PartType[]>;
  view(ownerId: string): Promise<InventoryView>;
  upsert(ownerId: string, input: InventoryUpsertRequest): Promise<InventoryEntry[]>;
  update(ownerId: string, id: string, patch: Partial<InventoryEntry>): Promise<InventoryEntry>;
  remove(ownerId: string, id: string): Promise<void>;
}

export interface InventoryServiceDependencies { db: DB; sqlite: SqliteDatabase; catalog: CatalogService; store: MissionStore; }

export class SqlInventoryService implements InventoryService {
  constructor(private readonly deps: InventoryServiceDependencies) {}

  async entries(ownerId: string): Promise<InventoryEntry[]> {
    const rows = this.deps.sqlite.prepare('SELECT * FROM "inventory_items" WHERE "ownerId" = ? ORDER BY "createdAt"').all(ownerId) as ItemRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async types(ownerId: string): Promise<PartType[]> { return this.deps.catalog.types(ownerId); }

  async view(ownerId: string): Promise<InventoryView> {
    const entries = await this.entries(ownerId);
    const types = await this.types(ownerId);
    const missions = await this.deps.store.listMissions(ownerId);
    const missionRevisions = await Promise.all(missions.map(async (mission) => ({ mission, revision: mission.currentRevision === undefined ? null : await this.deps.store.getRevision(mission.id, mission.currentRevision) })));
    return {
      entries: entries.map((entry) => {
        const type = types.find((candidate) => candidate.id === entry.typeId);
        const mapping = type?.mapping;
        const module = mapping && (mapping.kind === "module" || mapping.kind === "modelled") ? mapping.module : undefined;
        const mappedValues = mapping && (mapping.kind === "module" || mapping.kind === "modelled") ? { ...(mapping.fixed ?? {}), ...Object.fromEntries(Object.entries(mapping.params ?? {}).map(([moduleKey, fieldKey]) => [moduleKey, entry.values[fieldKey]])) } : {};
        const usedIn = module ? missionRevisions.filter(({ revision }) => revision?.circuit.parts.some((part) => part.module === module && Object.entries(mappedValues).every(([key, value]) => JSON.stringify(part.params[key]) === JSON.stringify(value)))).map(({ mission }) => ({ missionId: mission.id, title: mission.title })) : [];
        return { ...entry, usedIn };
      }),
    };
  }

  async upsert(ownerId: string, input: InventoryUpsertRequest): Promise<InventoryEntry[]> {
    const types = await this.types(ownerId);
    const now = Date.now();
    const transaction = this.deps.sqlite.transaction(() => {
      for (const item of input.items) {
        const type = types.find((candidate) => candidate.id === item.typeId);
        if (!type) throw new Error(`unknown part type ${item.typeId}`);
        const baseIdentity = inventoryIdentity(type, item.values);
        const desiredStatus = item.status ?? "ready";
        const readyExisting = this.deps.sqlite.prepare('SELECT * FROM "inventory_items" WHERE "ownerId" = ? AND "identity" = ?').get(ownerId, baseIdentity) as ItemRow | undefined;
        const uncertainExisting = this.deps.sqlite.prepare('SELECT * FROM "inventory_items" WHERE "ownerId" = ? AND "typeId" = ? AND "identity" LIKE ? ORDER BY "createdAt" LIMIT 1').get(ownerId, item.typeId, `${baseIdentity}|needs-look|%`) as ItemRow | undefined;
        const existing = desiredStatus === "needs-look" ? (readyExisting ? undefined : uncertainExisting) : (readyExisting ?? uncertainExisting);
        const identity = desiredStatus === "needs-look" && readyExisting ? `${baseIdentity}|needs-look|${randomUUID()}` : (existing?.identity ?? baseIdentity);
        const quantity = existing && item.mode === "add" ? existing.quantity + item.quantity : item.quantity;
        const values = JSON.stringify(item.values);
        const candidates = item.candidates ? JSON.stringify(item.candidates) : null;
        if (existing) {
          this.deps.sqlite.prepare('UPDATE "inventory_items" SET "typeId" = ?, "identity" = ?, "values" = ?, "quantity" = ?, "status" = ?, "source" = ?, "candidates" = ?, "photoUrl" = ?, "note" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run(item.typeId, identity, values, quantity, desiredStatus, item.source, candidates, item.photoUrl ?? existing.photoUrl, item.note ?? existing.note, now, existing.id, ownerId);
        } else {
          this.deps.sqlite.prepare('INSERT INTO "inventory_items" ("id", "ownerId", "typeId", "identity", "values", "quantity", "status", "source", "candidates", "photoUrl", "note", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), ownerId, item.typeId, identity, values, item.quantity, desiredStatus, item.source, candidates, item.photoUrl ?? null, item.note ?? null, now, now);
        }
      }
    });
    transaction();
    return this.entries(ownerId);
  }

  async update(ownerId: string, id: string, patch: Partial<InventoryEntry>): Promise<InventoryEntry> {
    const current = this.deps.sqlite.prepare('SELECT * FROM "inventory_items" WHERE "id" = ? AND "ownerId" = ?').get(id, ownerId) as ItemRow | undefined;
    if (!current) throw Object.assign(new Error("inventory item not found"), { status: 404, code: "INVENTORY_ITEM_NOT_FOUND" });
    const typeId = patch.typeId ?? current.typeId;
    const values = patch.values ?? (JSON.parse(current.values) as Record<string, FieldValue>);
    const type = (await this.types(ownerId)).find((candidate) => candidate.id === typeId);
    if (!type) throw Object.assign(new Error(`Unknown part type ${typeId}`), { status: 400, code: "UNKNOWN_PART_TYPE" });
    const identity = inventoryIdentity(type, values);
    const collision = this.deps.sqlite.prepare('SELECT * FROM "inventory_items" WHERE "ownerId" = ? AND "identity" = ? AND "id" != ?').get(ownerId, identity, id) as ItemRow | undefined;
    if (collision) {
      this.deps.sqlite.prepare('UPDATE "inventory_items" SET "quantity" = ?, "updatedAt" = ? WHERE "id" = ?').run(collision.quantity + (patch.quantity ?? current.quantity), Date.now(), collision.id);
      await this.remove(ownerId, id);
      const merged = await this.entries(ownerId);
      const found = merged.find((entry) => entry.id === collision.id);
      if (!found) throw new Error("inventory merge failed");
      return found;
    }
    this.deps.sqlite.prepare('UPDATE "inventory_items" SET "typeId" = ?, "identity" = ?, "values" = ?, "quantity" = ?, "status" = ?, "source" = ?, "photoUrl" = ?, "note" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run(typeId, identity, JSON.stringify(values), patch.quantity ?? current.quantity, patch.status ?? current.status, patch.source ?? current.source, patch.photoUrl ?? current.photoUrl, patch.note ?? current.note, Date.now(), id, ownerId);
    const updated = (await this.entries(ownerId)).find((entry) => entry.id === id);
    if (!updated) throw new Error("inventory update failed");
    return updated;
  }

  async remove(ownerId: string, id: string): Promise<void> { this.deps.sqlite.prepare('DELETE FROM "inventory_items" WHERE "id" = ? AND "ownerId" = ?').run(id, ownerId); }

  private fromRow(row: ItemRow): InventoryEntry {
    return { id: row.id, typeId: row.typeId, values: JSON.parse(row.values) as Record<string, FieldValue>, quantity: row.quantity, status: row.status as EntryStatus, source: row.source as EntrySource, ...(row.candidates ? { candidates: JSON.parse(row.candidates) as Array<Record<string, FieldValue>> } : {}), ...(row.photoUrl ? { photoUrl: row.photoUrl } : {}), ...(row.note ? { note: row.note } : {}), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
  }
}

export function createInventoryService(deps: InventoryServiceDependencies): InventoryService { return new SqlInventoryService(deps); }
