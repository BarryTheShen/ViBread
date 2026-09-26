/**
 * Parts catalog + user inventory + camera scan contracts (docs/ui-redesign-plan.md §5). Shared by server, web and agents.
 *
 * - A PartType is an "object" with fields (LED → color, size). Built-in types ship in code (catalog-data.ts); users add
 *   their own (stored per user). Every type has a support level that decides what ViBread can do with it.
 * - An InventoryEntry is one line of the user's parts: type + field values + quantity. Same type + same identity values
 *   = the same entry (quantities add up).
 * - Missions never read the inventory directly: at creation the usable entries are copied into Mission.inventory
 *   (mission.ts InventoryItem) through the type's mapping, so the design agent and the checks stay unchanged.
 */
import type { ModuleKey, ModulePin } from "./modules.js";

/** What ViBread can do with a part type. */
export const SUPPORT_LEVELS = [
  /** Designed, checked, simulated, placed on the breadboard, self-tested (a module-library part). */
  "full",
  /** Uses a full part's simulation and checks, always labelled "modelled as …" (thermistor → light sensor). */
  "modelled",
  /** Generic part with the user's pins: basic simulation, always marked unverified, no bench self-test. */
  "basic",
  /** Kept in the inventory; the design agent is told the user owns it but never designs with it. */
  "list-only",
  /** Board, breadboard and supplies: used by the mission and the build steps, never a circuit part. */
  "supply",
] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const PART_CATEGORIES = [
  "lights",
  "resistors",
  "switches",
  "sensors",
  "sound",
  "displays",
  "motors",
  "semiconductors",
  "passives",
  "modules",
  "board",
  "supplies",
  "other",
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

export const FIELD_KINDS = ["choice", "number", "boolean", "text"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export type FieldValue = string | number | boolean;

export interface PartField {
  /** Stable key inside the type ("color", "ohms", "size"). */
  key: string;
  label: string;
  kind: FieldKind;
  /** "Ω", "mm", "V" … */
  unit?: string;
  /** Allowed values for kind "choice" (users may add values to fields that aren't electrical). */
  options?: string[];
  min?: number;
  max?: number;
  /** Part of the entry identity: a different value is a different part (LED color yes, brand no). */
  identity: boolean;
  /** Changes the electronics (checks/simulation use it); new values need electrical data (e.g. an LED color's Vf). */
  electrical: boolean;
  /** Required before the entry is "ready". */
  required?: boolean;
}

export const GENERIC_ROLES = ["digital-sensor", "analog-sensor", "digital-actuator"] as const;
export type GenericRole = (typeof GENERIC_ROLES)[number];

/** How entries of a type are copied into a mission (Mission.inventory) — see §5.4 of the plan. */
export type PartMapping =
  /** A module-library part; `params` maps module param → field key (e.g. { color: "color" }, { ohms: "ohms" }). */
  | { kind: "module"; module: ModuleKey; params?: Record<string, string>; fixed?: Record<string, unknown> }
  /** Copied as the base module, labelled "<type name> (modelled as <module name>)". */
  | { kind: "modelled"; module: ModuleKey; params?: Record<string, string>; fixed?: Record<string, unknown> }
  /** Copied as a `generic` part with this role, the type's description and its pinout. */
  | { kind: "generic"; role: GenericRole }
  /** Not copied as a part; the design agent gets a text line ("also owns 1 SG90 servo — can't design with it"). */
  | { kind: "note" }
  /** Board / breadboard feed mission settings (SHOULD); jumpers and cables are never copied. */
  | { kind: "setting"; setting: "board" | "breadboard" | "none" };

export interface PartType {
  /** Built-in: short slug ("led", "tilt-switch"). User-made: "u-" + uuid. */
  id: string;
  name: string;
  category: PartCategory;
  /** Other names people type or print on packaging (typed quick-add + scanning). */
  aliases: string[];
  /** One sentence telling the vision model how it looks in a photo. */
  photoHint: string;
  /** Plain description (also the generic part's description). */
  description: string;
  fields: PartField[];
  support: SupportLevel;
  mapping: PartMapping;
  /** Basic (generic) parts: the pins, in order, with electrical types. */
  pinout?: ModulePin[];
  builtIn: boolean;
}

export const ENTRY_STATUSES = [
  /** Usable in designs. */
  "ready",
  /** A value is unsure (e.g. resistor 10 kΩ vs 1 kΩ) or a required field is empty: fix before it's used. */
  "needs-look",
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_SOURCES = ["scan", "typed", "manual", "preset"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** One line of the user's inventory. */
export interface InventoryEntry {
  id: string;
  typeId: string;
  values: Record<string, FieldValue>;
  quantity: number;
  status: EntryStatus;
  source: EntrySource;
  /** needs-look: the possible values to pick from (e.g. [{ ohms: 10000 }, { ohms: 1000 }]). */
  candidates?: Array<Record<string, FieldValue>>;
  /** Crop from the scan photo, if it came from a scan. */
  photoUrl?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Missions that use this entry (inventory page "used in"). */
export interface InventoryEntryUse {
  missionId: string;
  title: string;
}

export interface InventoryView {
  entries: Array<InventoryEntry & { usedIn: InventoryEntryUse[] }>;
}

export interface CatalogView {
  /** Built-in types first, then the user's own. */
  types: PartType[];
}

/** POST /api/inventory/items — batch add or replace. */
export interface InventoryUpsertRequest {
  items: Array<{
    typeId: string;
    values: Record<string, FieldValue>;
    quantity: number;
    /** add: quantity is added to an existing entry with the same identity; replace: it becomes the new quantity. */
    mode: "add" | "replace";
    source: EntrySource;
    status?: EntryStatus;
    candidates?: Array<Record<string, FieldValue>>;
    photoUrl?: string;
    note?: string;
  }>;
}

/** POST /api/inventory/parse — typed quick-add ("3 red LEDs, 5x 220 ohm") → preview (no AI, nothing saved). */
export interface ParsedPartLine {
  /** The text this line came from. */
  text: string;
  typeId: string | null;
  values: Record<string, FieldValue>;
  quantity: number;
  status: EntryStatus | "unknown";
  candidates?: Array<Record<string, FieldValue>>;
}
export interface ParsePartsResponse {
  lines: ParsedPartLine[];
}

// ── Camera scan ───────────────────────────────────────────────────────────────────────────────────────────────────

export const SCAN_STATUSES = ["waiting", "analyzing", "ready", "failed", "accepted"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** What the vision model reports for one group of parts (observations only; values are derived by our normalizer). */
export interface ScanObservation {
  photoIndex: number;
  /** A catalog type id, or null when the model can't tell. */
  typeId: string | null;
  /** Short description in the model's words ("blue 4-pin module"). */
  label: string;
  count: number;
  confidence: "high" | "check" | "unknown";
  /** Bounding box in pixels of the analyzed (resized) photo: [x, y, width, height]. */
  box: [number, number, number, number];
  lensColor?: string;
  /** Resistor bands, left to right as seen. */
  bands?: string[];
  /** Printed text/codes ("103", "B10K", "SG90"). */
  printed?: string;
  pins?: number;
  notes?: string;
}

/** One review row (normalized). */
export interface ScanItem {
  index: number;
  typeId: string | null;
  label: string;
  values: Record<string, FieldValue>;
  quantity: number;
  status: EntryStatus | "unknown";
  candidates?: Array<Record<string, FieldValue>>;
  /** GET /api/inventory/scans/:id/crops/:index */
  cropUrl: string;
  /** Present when an entry with the same identity already exists (review shows "have 10 → will be 19"). */
  existing?: { entryId: string; quantity: number };
}

export interface ScanView {
  id: string;
  status: ScanStatus;
  photos: number;
  items: ScanItem[];
  error?: string;
  /** Scanning needs a Claude credential for the scan's owner. */
  claude: "connected" | "missing";
  createdAt: string;
}

/** POST /api/inventory/scans/:id/accept */
export interface ScanAcceptRequest {
  items: Array<{ index: number; typeId: string; values: Record<string, FieldValue>; quantity: number; mode: "add" | "replace" }>;
}
