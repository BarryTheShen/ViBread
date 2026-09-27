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
import { BOARD_VARIANT_IDS, BOARD_VARIANTS, type BoardVariantId } from "./boards.js";
import { BREADBOARD_PROFILE_IDS, BREADBOARD_PROFILES, type BreadboardProfileId } from "./breadboards.js";
import type { ModuleKey, ModulePin } from "./modules.js";
import { PART_VARIANTS } from "./variants.js";

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
  errorCode?: string;
  retryAfter?: string;
  /** Scanning needs a Claude credential for the scan's owner. */
  claude: "connected" | "missing";
  createdAt: string;
}

/** POST /api/inventory/scans/:id/accept */
export interface ScanAcceptRequest {
  items: Array<{ index: number; typeId: string; values: Record<string, FieldValue>; quantity: number; mode: "add" | "replace" }>;
}

// ── Your hardware (issue #23) ─────────────────────────────────────────────────────────────────────────────────────

/** The breadboard, board and part variants you build with. New missions default to them. */
export interface MyHardware {
  breadboard: BreadboardProfileId;
  board: BoardVariantId;
  /** Module → the variant key you own (`params.variant`, variants.ts), e.g. { led: "3mm", button: "2leg" }. */
  parts: Partial<Record<ModuleKey, string>>;
}

/** Where each hardware choice came from: picked on the inventory page, implied by an inventory entry, or the default. */
export type HardwareSource = "saved" | "inventory" | "default";

/** GET/PUT /api/inventory/hardware */
export interface HardwareView {
  hardware: MyHardware;
  source: { breadboard: HardwareSource; board: HardwareSource };
  /** Photo identification needs a Claude credential; without one the page offers the manual pickers only. */
  claude: "connected" | "missing";
}

export const HARDWARE_KINDS = ["breadboard", "board", "part"] as const;
export type HardwareKind = (typeof HARDWARE_KINDS)[number];

export const HARDWARE_CONFIDENCES = ["high", "medium", "low"] as const;
export type HardwareConfidence = (typeof HARDWARE_CONFIDENCES)[number];

/** What the vision model reports for one photo of a breadboard, board or part (observations plus its best match). */
export interface HardwareAnswer {
  kind: HardwareKind | "unknown";
  /** Breadboard profile id, board variant id, or part variant id from the list it was given; null when none fits. */
  id: string | null;
  confidence: HardwareConfidence;
  /** Short observations behind the match ("counted 30 numbered rows", "chip marked CH340G"). */
  reasons: string[];
  /** What it is, in plain words (prefills a user-made part type when nothing matches). */
  description: string;
  /** Breadboards: numbered rows counted, whether the rail lines break in the middle, whether there are rails at all. */
  rows?: number;
  railGap?: boolean;
  rails?: boolean;
  /** Printed text read verbatim ("CH340G", "UNO", "B10K"). */
  printed?: string;
}

/** POST /api/inventory/hardware/identify → the checked guess the person confirms or replaces. */
export interface HardwareIdentification {
  kind: HardwareKind | "unknown";
  profileOrVariantId: string | null;
  confidence: HardwareConfidence;
  reasons: string[];
  description: string;
  /** Other catalogue ids of the same kind, for "choose another". */
  alternatives: string[];
}

const CONFIDENCE_RANK: Record<HardwareConfidence, number> = { high: 2, medium: 1, low: 0 };
const lowerOf = (a: HardwareConfidence, b: HardwareConfidence): HardwareConfidence => (CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b);

/** Catalogue ids per kind (the only ids a guess may name). */
export function hardwareIds(kind: HardwareKind): string[] {
  if (kind === "breadboard") return [...BREADBOARD_PROFILE_IDS];
  if (kind === "board") return [...BOARD_VARIANT_IDS];
  return PART_VARIANTS.map((variant) => variant.id);
}

/**
 * Turns the model's answer into the guess shown to the person. Deterministic checks win over the model's pick:
 * an id outside the catalogue (or of another kind) becomes null; a counted row number and rail observations pick the
 * breadboard profile they match; a board a photo can't tell apart (old vs new Nano bootloader) is never "high".
 * `expected` is the kind the person asked about, when they chose one.
 */
export function interpretHardwareAnswer(answer: HardwareAnswer, expected?: HardwareKind): HardwareIdentification {
  const reasons = [...answer.reasons];
  let kind = answer.kind;
  let id = answer.id;
  let confidence = answer.confidence;
  if (expected && kind !== expected && kind !== "unknown") {
    reasons.push(`This looks like a ${kind}, not a ${expected}.`);
    confidence = "low";
  }
  if (kind !== "unknown" && id !== null && !hardwareIds(kind).includes(id)) {
    reasons.push(`"${id}" isn't in ViBread's catalogue.`);
    id = null;
  }
  if (kind === "breadboard" || (kind === "unknown" && answer.rows !== undefined)) {
    const byRows = Object.values(BREADBOARD_PROFILES).filter((profile) => answer.rows === undefined || profile.rows === answer.rows);
    const byRails = byRows.filter((profile) => (answer.rails === false ? profile.railSides.length === 0 : answer.rails === true ? profile.railSides.length > 0 : true) && (answer.railGap === undefined || profile.railsSplit === answer.railGap));
    if (answer.rows !== undefined && byRows.length === 0) {
      reasons.push(`No standard breadboard has ${answer.rows} rows.`);
      confidence = lowerOf(confidence, "low");
    } else if (byRails.length === 1 && byRails[0]!.id !== id) {
      const match = byRails[0]!;
      reasons.push(`${answer.rows !== undefined ? `${answer.rows} rows` : "The rails"}${answer.railGap ? " with a break in the rails" : answer.rails === false ? " and no rails" : ""} match the ${match.shortName}.`);
      confidence = lowerOf(confidence, "medium");
      kind = "breadboard";
      id = match.id;
    }
  }
  if (kind === "board" && id !== null && !BOARD_VARIANTS[id as BoardVariantId].photoDistinct) {
    reasons.push("A photo can't tell the old and new Nano bootloaders apart: if uploading fails, try the other one.");
    confidence = lowerOf(confidence, "medium");
  }
  if (id === null) confidence = "low";
  return {
    kind,
    profileOrVariantId: id,
    confidence,
    reasons,
    description: answer.description,
    alternatives: kind === "unknown" ? [] : hardwareIds(kind).filter((candidate) => candidate !== id),
  };
}
