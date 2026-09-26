import { MODULES, type FieldValue, type InventoryEntry, type ModuleKey, type PartType, type SupportLevel } from "@vibread/core";
import { z } from "zod";

/** The owner's parts inventory (plan §5.4/§5.7). Implemented by ServerCore's inventory store. */
export interface InventorySource {
  entries(ownerId: string): Promise<InventoryEntry[]>;
  /** Built-in types plus the owner's own. */
  types(ownerId: string): Promise<PartType[]>;
}

const SUPPORT_TEXT: Record<SupportLevel, string> = {
  full: "ViBread designs, checks, simulates and self-tests it",
  modelled: "designed as a library part it behaves like (labelled 'modelled as …')",
  basic: "designed with its own pins; basic simulation, always unverified",
  "list-only": "kept in your list; ViBread can't design with it",
  supply: "board / breadboard / supplies",
};

function valueText(entry: InventoryEntry, type: PartType | undefined): string {
  const parts = Object.entries(entry.values).map(([key, value]: [string, FieldValue]) => {
    const field = type?.fields.find((f) => f.key === key);
    return `${field?.label ?? key} ${String(value)}${field?.unit ? ` ${field.unit}` : ""}`;
  });
  return parts.join(", ");
}

export interface InventoryOverview {
  summary: string;
  groups: {
    typeId: string;
    name: string;
    category: string;
    support: SupportLevel;
    supportText: string;
    /** Modelled types: the library part they're designed as. */
    modelledAs?: string;
    total: number;
    entries: { id: string; values: Record<string, FieldValue>; valuesText: string; quantity: number; status: InventoryEntry["status"]; note?: string }[];
  }[];
}

/** The owner's entries grouped by part type with support levels (read-only; vibread_get_inventory, get_inventory). */
export async function inventoryOverview(source: InventorySource, ownerId: string): Promise<InventoryOverview> {
  const [entries, types] = await Promise.all([source.entries(ownerId), source.types(ownerId)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const groups = new Map<string, InventoryOverview["groups"][number]>();
  for (const entry of entries) {
    const type = byId.get(entry.typeId);
    let group = groups.get(entry.typeId);
    if (!group) {
      const support: SupportLevel = type?.support ?? "list-only";
      const modelled = type?.mapping.kind === "modelled" ? MODULES[type.mapping.module as ModuleKey]?.name : undefined;
      group = {
        typeId: entry.typeId,
        name: type?.name ?? entry.typeId,
        category: type?.category ?? "other",
        support,
        supportText: SUPPORT_TEXT[support],
        ...(modelled ? { modelledAs: modelled } : {}),
        total: 0,
        entries: [],
      };
      groups.set(entry.typeId, group);
    }
    group.total += entry.quantity;
    group.entries.push({
      id: entry.id,
      values: entry.values,
      valuesText: valueText(entry, type),
      quantity: entry.quantity,
      status: entry.status,
      ...(entry.note ? { note: entry.note } : {}),
    });
  }
  const list = [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const needsLook = entries.filter((e) => e.status === "needs-look").length;
  return {
    summary: list.length
      ? `${list.length} kinds of parts, ${entries.reduce((n, e) => n + e.quantity, 0)} pieces${needsLook ? ` (${needsLook} need a look before use)` : ""}`
      : "The inventory is empty",
    groups: list,
  };
}

/**
 * A user-level (not mission-scoped) read-only tool. The MCP adapter registers it without `missionId`; the owner is the
 * authenticated user. Name is part of the public MCP surface.
 */
export interface UserToolDef<I = unknown, O = unknown> {
  name: string;
  title: string;
  description: string;
  actionClass: "read-only";
  input: z.ZodType<I>;
  handler: (ctx: { ownerId: string }, input: I) => Promise<O>;
}

export function createUserTools(deps: { inventory: InventorySource }): UserToolDef[] {
  const getInventory: UserToolDef<Record<string, never>, InventoryOverview> = {
    name: "vibread_get_inventory",
    title: "Your parts inventory",
    description:
      "The parts you own in ViBread, grouped by part type, with values (LED colour, resistance …), quantities, and what " +
      "ViBread can do with each (support level). New missions use these parts.",
    actionClass: "read-only",
    input: z.object({}).strict(),
    handler: (ctx) => inventoryOverview(deps.inventory, ctx.ownerId),
  };
  return [getInventory as unknown as UserToolDef];
}
