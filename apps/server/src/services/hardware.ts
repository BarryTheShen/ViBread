import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  BOARD_VARIANTS,
  BREADBOARD_PROFILES,
  DEFAULT_HARDWARE,
  MODULE_KEYS,
  hardwareFromInventory,
  isBoardVariantId,
  isBreadboardProfileId,
  variantsForModule,
  type HardwareSource,
  type InventoryEntry,
  type MissionStore,
  type ModuleKey,
  type MyHardware,
} from "@vibread/core";

/** Timeline event holding a mission's hardware snapshot (MyHardware data), written when the mission is created. */
export const MISSION_HARDWARE_EVENT = "mission.hardware";

/** The hardware a mission was created with; undefined for missions from before issue #23. */
export async function missionHardware(store: Pick<MissionStore, "listEvents">, missionId: string): Promise<MyHardware | undefined> {
  return (await store.listEvents(missionId)).find((event) => event.kind === MISSION_HARDWARE_EVENT)?.data as MyHardware | undefined;
}

/**
 * "Your hardware" (issue #23): the breadboard, board and part variants a user builds with. Saved choices win; a field
 * never picked falls back to the inventory's breadboard/Arduino entries, then to DEFAULT_HARDWARE.
 */
export interface HardwareService {
  get(ownerId: string): Promise<{ hardware: MyHardware; source: { breadboard: HardwareSource; board: HardwareSource } }>;
  save(ownerId: string, hardware: MyHardware): Promise<MyHardware>;
}

export class HardwareInputError extends Error {
  readonly status = 400;
  readonly code = "INVALID_HARDWARE";
}

/** Checks a PUT body against the catalogue (unknown ids and variants are rejected, never stored). */
export function parseMyHardware(input: unknown): MyHardware {
  const body = (input ?? {}) as Partial<Record<keyof MyHardware, unknown>>;
  if (!isBreadboardProfileId(body.breadboard)) throw new HardwareInputError(`Unknown breadboard ${String(body.breadboard)}; use one of ${Object.keys(BREADBOARD_PROFILES).join(", ")}.`);
  if (!isBoardVariantId(body.board)) throw new HardwareInputError(`Unknown board ${String(body.board)}; use one of ${Object.keys(BOARD_VARIANTS).join(", ")}.`);
  const parts: MyHardware["parts"] = {};
  if (body.parts !== undefined) {
    if (typeof body.parts !== "object" || body.parts === null || Array.isArray(body.parts)) throw new HardwareInputError("parts must be an object of module → variant.");
    for (const [module, variant] of Object.entries(body.parts)) {
      if (!(MODULE_KEYS as readonly string[]).includes(module) || !variantsForModule(module as ModuleKey).some((candidate) => candidate.variant === variant)) {
        throw new HardwareInputError(`Unknown variant ${String(variant)} for ${module}.`);
      }
      parts[module as ModuleKey] = variant as string;
    }
  }
  return { breadboard: body.breadboard, board: body.board, parts };
}

export function createHardwareService(deps: { sqlite: SqliteDatabase; inventory: { entries(ownerId: string): Promise<InventoryEntry[]> } }): HardwareService {
  return {
    async get(ownerId) {
      const row = deps.sqlite.prepare('SELECT "json" FROM "hardware_choices" WHERE "ownerId" = ?').get(ownerId) as { json: string } | undefined;
      if (row) return { hardware: JSON.parse(row.json) as MyHardware, source: { breadboard: "saved", board: "saved" } };
      const implied = hardwareFromInventory(await deps.inventory.entries(ownerId));
      return {
        hardware: { ...DEFAULT_HARDWARE, ...implied, parts: {} },
        source: { breadboard: implied.breadboard ? "inventory" : "default", board: implied.board ? "inventory" : "default" },
      };
    },
    async save(ownerId, hardware) {
      deps.sqlite
        .prepare('INSERT INTO "hardware_choices" ("ownerId", "json", "updatedAt") VALUES (?, ?, ?) ON CONFLICT("ownerId") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"')
        .run(ownerId, JSON.stringify(hardware), Date.now());
      return hardware;
    },
  };
}
