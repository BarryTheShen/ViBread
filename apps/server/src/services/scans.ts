import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { ScanItem, ScanObservation, ScanStatus, ScanView, PartType, InventoryEntry, MissionStore, ScanAcceptRequest } from "@vibread/core";
import type { DB } from "../db/schema.js";
import type { InventoryService } from "./inventory.js";

interface ScanRow { id: string; ownerId: string; status: string; photos: string; analyzed: string | null; observations: string | null; items: string | null; error: string | null; errorCode: string | null; retryAfter: number | null; createdAt: number; updatedAt: number; }
export interface ScanService {
  create(ownerId: string): Promise<ScanView>;
  addPhoto(ownerId: string, scanId: string, hash: string): Promise<ScanView>;
  photoHashes(ownerId: string, scanId: string): Promise<string[]>;
  analyzed(ownerId: string, scanId: string): Promise<Array<{ hash: string; width: number; height: number }>>;
  observations(ownerId: string, scanId: string): Promise<ScanObservation[]>;
  get(ownerId: string, scanId: string): Promise<ScanView | null>;
  fail(ownerId: string, scanId: string, input: { code: string; message: string; retryAfter?: string }): Promise<ScanView>;
  analyze(ownerId: string, scanId: string, input: { observations: ScanObservation[]; analyzed: Array<{ hash: string; width: number; height: number }>; items?: ScanItem[] }, types: PartType[], inventory: InventoryEntry[]): Promise<ScanView>;
  accept(ownerId: string, scanId: string, items: ScanAcceptRequest["items"], inventory: InventoryService): Promise<InventoryEntry[]>;
}

export interface ScanServiceDependencies { db: DB; sqlite: SqliteDatabase; store: MissionStore; }

export class SqlScanService implements ScanService {
  constructor(private readonly deps: ScanServiceDependencies) {}

  async create(ownerId: string): Promise<ScanView> {
    const id = randomUUID(); const now = Date.now();
    this.deps.sqlite.prepare('INSERT INTO "inventory_scans" ("id", "ownerId", "status", "photos", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run(id, ownerId, "waiting", "[]", now, now);
    const view = await this.get(ownerId, id); if (!view) throw new Error("scan not persisted"); return view;
  }

  async addPhoto(ownerId: string, scanId: string, hash: string): Promise<ScanView> {
    const row = this.requireRow(ownerId, scanId); const photos = JSON.parse(row.photos) as string[]; photos.push(hash);
    this.deps.sqlite.prepare('UPDATE "inventory_scans" SET "photos" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run(JSON.stringify(photos), Date.now(), scanId, ownerId);
    const view = await this.get(ownerId, scanId); if (!view) throw new Error("scan disappeared"); return view;
  }

  async photoHashes(ownerId: string, scanId: string): Promise<string[]> {
    return JSON.parse(this.requireRow(ownerId, scanId).photos) as string[];
  }

  async analyzed(ownerId: string, scanId: string): Promise<Array<{ hash: string; width: number; height: number }>> {
    return this.requireRow(ownerId, scanId).analyzed ? JSON.parse(this.requireRow(ownerId, scanId).analyzed!) as Array<{ hash: string; width: number; height: number }> : [];
  }

  async observations(ownerId: string, scanId: string): Promise<ScanObservation[]> {
    return this.requireRow(ownerId, scanId).observations ? JSON.parse(this.requireRow(ownerId, scanId).observations!) as ScanObservation[] : [];
  }

  async get(ownerId: string, scanId: string): Promise<ScanView | null> {
    const row = this.deps.sqlite.prepare('SELECT * FROM "inventory_scans" WHERE "id" = ? AND "ownerId" = ?').get(scanId, ownerId) as ScanRow | undefined;
    return row ? this.fromRow(row) : null;
  }
  async fail(ownerId: string, scanId: string, input: { code: string; message: string; retryAfter?: string }): Promise<ScanView> {
    this.requireRow(ownerId, scanId);
    this.deps.sqlite.prepare('UPDATE "inventory_scans" SET "status" = ?, "error" = ?, "errorCode" = ?, "retryAfter" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run("failed", input.message, input.code, input.retryAfter ? Date.parse(input.retryAfter) : null, Date.now(), scanId, ownerId);
    const view = await this.get(ownerId, scanId);
    if (!view) throw new Error("scan disappeared");
    return view;
  }
  async analyze(ownerId: string, scanId: string, input: { observations: ScanObservation[]; analyzed: Array<{ hash: string; width: number; height: number }>; items?: ScanItem[] }, types: PartType[], inventory: InventoryEntry[]): Promise<ScanView> {
    const row = this.requireRow(ownerId, scanId);
    const items: ScanItem[] = input.items ?? input.observations.map((observation, index) => ({ index, typeId: observation.typeId, label: observation.label, values: {}, quantity: observation.count, status: observation.confidence === "high" && observation.typeId ? "ready" : "needs-look", cropUrl: `/api/inventory/scans/${scanId}/crops/${index}` }));
    void row;
    this.deps.sqlite.prepare('UPDATE "inventory_scans" SET "status" = ?, "analyzed" = ?, "observations" = ?, "items" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run("ready", JSON.stringify(input.analyzed), JSON.stringify(input.observations), JSON.stringify(items), Date.now(), scanId, ownerId);
    const view = await this.get(ownerId, scanId);
    if (!view) throw new Error("scan disappeared");
    return view;
  }
  async accept(ownerId: string, scanId: string, items: ScanAcceptRequest["items"], inventory: InventoryService): Promise<InventoryEntry[]> {
    const row = this.requireRow(ownerId, scanId); const accepted = items.filter((item) => item.typeId).map((item) => ({ typeId: item.typeId, values: item.values, quantity: item.quantity, mode: item.mode, source: "scan" as const }));
    const entries = await inventory.upsert(ownerId, { items: accepted });
    this.deps.sqlite.prepare('UPDATE "inventory_scans" SET "status" = ?, "updatedAt" = ? WHERE "id" = ? AND "ownerId" = ?').run("accepted", Date.now(), scanId, ownerId); void row;
    return entries;
  }

  private requireRow(ownerId: string, scanId: string): ScanRow { const row = this.deps.sqlite.prepare('SELECT * FROM "inventory_scans" WHERE "id" = ? AND "ownerId" = ?').get(scanId, ownerId) as ScanRow | undefined; if (!row) throw new Error("scan not found"); return row; }

  private fromRow(row: ScanRow): ScanView { return { id: row.id, status: row.status as ScanStatus, photos: (JSON.parse(row.photos) as string[]).length, items: row.items ? JSON.parse(row.items) as ScanItem[] : [], ...(row.error ? { error: row.error } : {}), ...(row.errorCode ? { errorCode: row.errorCode } : {}), ...(row.retryAfter ? { retryAfter: new Date(row.retryAfter).toISOString() } : {}), claude: "missing", createdAt: new Date(row.createdAt).toISOString() }; }
}

export function createScanService(deps: ScanServiceDependencies): ScanService { return new SqlScanService(deps); }
