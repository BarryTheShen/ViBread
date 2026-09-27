import { createHash } from "node:crypto";
import { basename } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";
import type { UIMessage } from "ai";
import {
  CircuitSchema,
  isWireColorValue,
  MODULE_KEYS,
  revisionHash,
  TestSuiteSchema,
  type Actor,
  type Mission,
  type MissionStore,
  type MyHardware,
  type Revision,
  type RevisionResults,
  type TimelineEvent,
} from "@vibread/core";
import type { BackgroundPipeline } from "@vibread/tools";
import { z } from "zod";
import type { MissionMachine } from "./machine.js";
import { BUILD_PROGRESS_EVENT, doneSteps } from "./build-progress.js";
import { MISSION_HARDWARE_EVENT, parseMyHardware } from "./hardware.js";
import { WIRE_COLOR_EVENT, wireOverrides } from "./wire-colors.js";
import { APP_VERSION } from "../version.js";
import type { MessageStore } from "../store/messages.js";

/** The on-disk project contract. Keep this independent of the SQLite schema: project files are portable. */
export const PROJECT_FORMAT = "vibread.project" as const;
export const PROJECT_VERSION = 1 as const;
export const PROJECT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const PROJECT_MAX_ENTRIES = 512;
export const PROJECT_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const INVALID_PROJECT = "This file isn't a ViBread project";
const NEWER_PROJECT = (version: number) => `This project was made by a newer ViBread (format v${version})`;

const CHANNELS = ["web", "imessage", "mcp", "a2a", "system"] as const;
const ACTOR_KINDS = ["human", "agent", "system"] as const;
const PHASES = ["BRIEF", "CLARIFY", "DESIGN", "GONOGO", "ASSEMBLE", "VERIFY", "DEBUG", "LAUNCH", "DONE"] as const;
const CONSOLES = ["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"] as const;

const ProjectActorSchema = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    channel: z.enum(CHANNELS),
  })
  .passthrough();

const ProjectInventoryItemSchema = z
  .object({
    module: z.enum(MODULE_KEYS),
    count: z.number().int().positive(),
    params: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
    label: z.string().optional(),
    pinout: z.array(z.unknown()).optional(),
  })
  .passthrough();
const PreservedResultsSchema = z
  .object({
    /** RETRO is non-deterministic, so its report is carried over while deterministic checks are re-run. */
    reports: z.array(z.unknown()).max(16).optional(),
    /** Bench telemetry and photo checks are user content rather than derived drawings or binaries. */
    bench: z.array(z.unknown()).max(1_000).optional(),
    photos: z.array(z.unknown()).max(1_000).optional(),
  })
  .passthrough();

const PhotoArtifactSchema = z.object({
  key: z.string().min(1),
  path: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const ProjectRevisionSchema = z
  .object({
    n: z.number().int().positive(),
    hash: z.string().min(1).optional(),
    parent: z.number().int().positive().optional(),
    circuit: CircuitSchema,
    suite: TestSuiteSchema.optional(),
    author: ProjectActorSchema,
    note: z.string().optional(),
    createdAt: z.string().min(1),
    preserved: PreservedResultsSchema.optional(),
    photoArtifacts: z.array(PhotoArtifactSchema).max(1_000).optional(),
  })
  .passthrough();

const ProjectTimelineSchema = z
  .object({
    at: z.string().min(1),
    channel: z.enum(CHANNELS),
    actor: ProjectActorSchema.optional(),
    kind: z.string().min(1),
    text: z.string(),
    revision: z.number().int().positive().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const ProjectSchema = z
  .object({
    format: z.literal(PROJECT_FORMAT),
    version: z.number().int().positive(),
    exportedAt: z.string().min(1),
    app: z.object({ version: z.string().min(1) }).passthrough(),
    mission: z
      .object({
        title: z.string().min(1).max(200),
        brief: z.string().min(1),
        phase: z.enum(PHASES).optional(),
        currentRevision: z.number().int().positive().optional(),
        releasedRevision: z.number().int().positive().optional(),
        inventory: z.array(ProjectInventoryItemSchema),
        inventoryNotes: z.array(z.string()).optional(),
      })
      .passthrough(),
    revisions: z.array(ProjectRevisionSchema).max(1_000),
    chat: z.array(z.record(z.string(), z.unknown())).max(10_000),
    timeline: z.array(ProjectTimelineSchema).max(20_000),
    buildProgress: z
      .object({ revision: z.number().int().positive().nullable(), done: z.array(z.number().int().positive()).max(10_000) })
      .passthrough(),
    wireColors: z.record(z.string(), z.string()),
    hardware: z
      .object({ breadboard: z.string().min(1), board: z.string().min(1), parts: z.record(z.string(), z.string()) })
      .passthrough()
      .optional(),
    attachments: z.array(z.object({ path: z.string().min(1), contentType: z.string().min(1), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() })).max(10_000),
    integrity: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  })
  .passthrough();

export type ProjectDocument = z.infer<typeof ProjectSchema>;

export interface ProjectAttachment {
  data: Uint8Array;
  contentType: string;
}

export interface ParsedProject {
  document: ProjectDocument;
  attachments: Map<string, ProjectAttachment>;
}

export class ProjectFileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

export interface ProjectFileDependencies {
  store: MissionStore;
  messages: MessageStore;
  machine: MissionMachine;
  pipeline: BackgroundPipeline;
  deleteMission?: (missionId: string) => void;
  log?: { warn(fields: unknown, message: string): void };
}

export interface ProjectFileService {
  export(missionId: string): Promise<{ bytes: Uint8Array; fileName: string }>;
  import(input: { bytes: Uint8Array; ownerId: string; fileName?: string }): Promise<{ missionId: string }>;
}

/** Timeline rows that describe work the person can act on or understand. Credentials, approvals and debug noise stay out. */
const MEANINGFUL_EVENTS = new Set([
  "mission.recorded",
  "project.imported",
  "revision.created",
  "revision.released",
  "release.review-recorded",
  "release.review-waived",
  "revision.rechecked",
  "phase.changed",
  "console.report",
  "bench.run",
  "photo.checked",
  "message",
  "build.step",
  BUILD_PROGRESS_EVENT,
  WIRE_COLOR_EVENT,
]);

const SENSITIVE_KEYS = /^(?:ownerid|userid|email|credential|credentials|token|secret|apikey|accesskey|password|privatekey|authorization|pairing|linkcode|handle|phone|phonenumber|mcpurl|publicurl)$/;
const LINK_KEYS = /(?:url|uri|link)$/i;
const sensitiveKey = (key: string): boolean => SENSITIVE_KEYS.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
const PORTABLE_IMAGE_CONTENT_TYPE = new RegExp("^image/(?:jpeg|png|webp|gif|avif|bmp)$", "i");
const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActor(value: unknown): value is { kind: (typeof ACTOR_KINDS)[number]; channel: (typeof CHANNELS)[number]; name?: string } {
  if (!isRecord(value)) return false;
  return ACTOR_KINDS.includes(value.kind as (typeof ACTOR_KINDS)[number]) && CHANNELS.includes(value.channel as (typeof CHANNELS)[number]);
}

/** Actor ids are deliberately never written to a portable file; imported events use a fresh neutral id. */
function safeActor(value: unknown): Record<string, unknown> {
  if (!isActor(value)) return { kind: "system", channel: "system" };
  const name = typeof value.name === "string" && !/[\r\n]|@|https?:\/\//i.test(value.name) ? value.name.slice(0, 200) : undefined;
  return { kind: value.kind, channel: value.channel, ...(name ? { name } : {}) };
}

/** Remove account and personal-link fields from event/message payloads while keeping recorded labels and user text. */
function safeValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey(key)) return undefined;
  if (typeof value === "string" && key && LINK_KEYS.test(key) && !value.startsWith("attachments/") && !value.startsWith("/api/recorded/")) return undefined;
  if (isActor(value)) return safeActor(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item)).filter((item) => item !== undefined);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const clean = safeValue(childValue, childKey);
      if (clean !== undefined) output[childKey] = clean;
    }
    return output;
  }
  return value;
}

/**
 * SHA-256 of `value` as JSON with object keys sorted at every level. Export and import must agree on the bytes they
 * hash, and key order isn't stable: zod rebuilds objects in schema order and SQLite rows come back in column order.
 */
function jsonHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function bytesHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutIntegrity(document: ProjectDocument): Omit<ProjectDocument, "integrity"> {
  const { integrity: _integrity, ...rest } = document;
  return rest;
}

function safeName(title: string): string {
  const normalized = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.\-_]+|[.\-_]+$/g, "")
    .slice(0, 100);
  return normalized || "project";
}

function safeAttachmentPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
}

function meaningfulEvent(event: TimelineEvent): boolean {
  return MEANINGFUL_EVENTS.has(event.kind);
}

function exportEvent(event: TimelineEvent): ProjectDocument["timeline"][number] {
  const data = safeValue(event.data);
  return {
    at: event.at,
    channel: event.channel,
    actor: safeActor(event.actor) as ProjectDocument["timeline"][number]["actor"],
    kind: event.kind,
    text: event.text.slice(0, 4_000),
    ...(event.revision === undefined ? {} : { revision: event.revision }),
    ...(data === undefined ? {} : { data }),
  };
}

function dataUrlAttachment(url: string): { contentType: string; data: Uint8Array } | undefined {
  const match = DATA_URL.exec(url);
  if (!match || !match[1] || !match[2]) return undefined;
  try {
    const data = new Uint8Array(Buffer.from(match[2], "base64"));
    if (!data.byteLength) return undefined;
    return { contentType: match[1].toLowerCase(), data };
  } catch {
    return undefined;
  }
}

function exportChat(messages: UIMessage[], attachments: Map<string, ProjectAttachment>): UIMessage[] {
  let attachmentNumber = 0;
  return messages.map((message) => {
    const parts = message.parts.map((part) => {
      if (part.type !== "file" || typeof part.url !== "string") return part;
      const photo = dataUrlAttachment(part.url);
      if (!photo) return safeValue(part) as typeof part;
      const extension = photo.contentType.split("/")[1]?.replace(/[^A-Za-z0-9]/g, "") || "bin";
      const path = `attachments/chat-${attachmentNumber++}.${extension}`;
      attachments.set(path, photo);
      return { ...part, url: path, mediaType: photo.contentType };
    });
    return safeValue({ ...message, parts }) as UIMessage;
  });
}

function importChat(messages: ProjectDocument["chat"], attachments: Map<string, ProjectAttachment>): UIMessage[] {
  return messages.map((raw) => {
    const message = structuredClone(raw) as unknown as UIMessage;
    if (!Array.isArray(message.parts)) return message;
    message.parts = message.parts.map((part) => {
      if (part.type !== "file" || typeof part.url !== "string" || !part.url.startsWith("attachments/")) return part;
      const attachment = attachments.get(part.url);
      if (!attachment) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
      return { ...part, url: `data:${attachment.contentType};base64,${Buffer.from(attachment.data).toString("base64")}`, mediaType: attachment.contentType };
    });
    return message;
  });
}

function preservedResults(revision: Revision): NonNullable<ProjectDocument["revisions"][number]["preserved"]> {
  const reports = revision.results.reports.filter((report) => report.console === "RETRO").map((report) => safeValue(report));
  return {
    ...(reports.length ? { reports } : {}),
    ...(revision.results.bench?.length ? { bench: safeValue(revision.results.bench) as unknown[] } : {}),
    ...(revision.results.photos?.length ? { photos: safeValue(revision.results.photos) as unknown[] } : {}),
  };
}

function reportLooksUsable(value: unknown): boolean {
  return isRecord(value) && CONSOLES.includes(value.console as (typeof CONSOLES)[number]) && typeof value.verdict === "string" && typeof value.summary === "string" && Array.isArray(value.findings);
}

function importedActor(value: unknown, fallback: string): Actor {
  const actor = isActor(value) ? value : undefined;
  const kind = actor?.kind ?? "system";
  const channel = actor?.channel ?? "system";
  return { kind, channel, id: `imported-${fallback}-${kind}`, ...(actor?.name ? { name: actor.name } : {}) };
}

function importedTimelineActor(value: unknown, fallback: string): Actor {
  return importedActor(value, fallback);
}

function attachmentPath(path: string): boolean {
  return /^attachments\/[A-Za-z0-9][A-Za-z0-9._/-]{0,220}$/.test(path) && !path.includes("..") && !path.endsWith("/");
}

function parsedProject(bytes: Uint8Array): ParsedProject {
  if (bytes.byteLength > PROJECT_MAX_UPLOAD_BYTES) throw new ProjectFileError(413, "PROJECT_TOO_LARGE", "This project file is too large (maximum 25 MB)");
  let files: Unzipped;
  let entries = 0;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entries++;
        if (entries > PROJECT_MAX_ENTRIES) throw new ProjectFileError(413, "PROJECT_TOO_MANY_ENTRIES", "This project has too many files");
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
        total += file.originalSize;
        if (total > PROJECT_MAX_UNCOMPRESSED_BYTES) throw new ProjectFileError(413, "PROJECT_TOO_LARGE", "This project is too large when unpacked (maximum 100 MB)");
        return file.name === "project.json" || attachmentPath(file.name);
      },
    });
  } catch (error) {
    if (error instanceof ProjectFileError) throw error;
    throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  const projectBytes = files["project.json"];
  if (!projectBytes || projectBytes.byteLength > PROJECT_MAX_UNCOMPRESSED_BYTES) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(projectBytes)) as unknown;
  } catch {
    throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  if (!isRecord(raw) || raw.format !== PROJECT_FORMAT || typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  if (raw.version > PROJECT_VERSION) throw new ProjectFileError(400, "NEWER_PROJECT", NEWER_PROJECT(raw.version));
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  const document = parsed.data;
  // Every v1 export carries the hash; a file without it was edited by hand (or truncated) and is refused like a mismatch.
  if (!document.integrity || document.integrity.toLowerCase() !== jsonHash(withoutIntegrity(raw as ProjectDocument))) {
    throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  const attachments = new Map<string, ProjectAttachment>();
  for (const entry of document.attachments) {
    if (!attachmentPath(entry.path) || entry.path === "project.json" || !PORTABLE_IMAGE_CONTENT_TYPE.test(entry.contentType)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
    const data = files[entry.path];
    if (!data || data.byteLength !== entry.size || (entry.sha256 && entry.sha256.toLowerCase() !== bytesHash(data))) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
    attachments.set(entry.path, { data, contentType: entry.contentType });
  }
  return { document, attachments };
}

function validateDocument(document: ProjectDocument): void {
  const ordered = [...document.revisions].sort((a, b) => a.n - b.n);
  if (ordered.some((revision, index) => revision.n !== index + 1)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  const numbers = new Set(ordered.map((revision) => revision.n));
  for (const revision of ordered) {
    if (revision.parent !== undefined && (!numbers.has(revision.parent) || revision.parent >= revision.n)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
    if (revision.hash && revision.hash !== revisionHash(revision.circuit, revision.suite)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
    if (revision.photoArtifacts?.some((photo) => !attachmentPath(photo.path) || !/^photo-(?:step-)?[A-Za-z0-9._-]{1,80}$/i.test(photo.key))) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  const current = document.mission.currentRevision;
  const released = document.mission.releasedRevision;
  if (current !== undefined && !numbers.has(current)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  if (released !== undefined && !numbers.has(released)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  if (released !== undefined && current !== undefined && released > current) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  if (document.buildProgress.revision !== null && !numbers.has(document.buildProgress.revision)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  for (const [key, color] of Object.entries(document.wireColors)) {
    if (!/^(?:wire|net):[A-Za-z0-9_+-]{1,32}$/.test(key) || !isWireColorValue(color)) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
  }
  if (document.hardware) {
    try {
      parseMyHardware(document.hardware);
    } catch {
      throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
    }
  }
}

async function restorePhase(machine: MissionMachine, mission: Mission, target: Mission["phase"]): Promise<void> {
  const silent = { silent: true };
  if (target === "BRIEF") return;
  if (target === "CLARIFY") {
    await machine.send(mission.id, { type: "BRIEF_RECEIVED" }, silent);
    return;
  }
  if (target === "DESIGN") {
    await machine.send(mission.id, { type: "DESIGN_STARTED" }, silent);
    return;
  }
  if (mission.currentRevision === undefined) return;
  await machine.send(mission.id, { type: "DESIGN_READY", revision: mission.currentRevision }, silent);
  if (target === "GONOGO") return;
  if (mission.releasedRevision === undefined) return;
  await machine.send(mission.id, { type: "RELEASED", revision: mission.releasedRevision }, silent);
  if (target === "ASSEMBLE") return;
  await machine.send(mission.id, { type: "BUILD_DONE" }, silent);
  if (target === "VERIFY") return;
  if (target === "DEBUG") {
    await machine.send(mission.id, { type: "VERIFY_FAILED" }, silent);
    return;
  }
  await machine.send(mission.id, { type: "VERIFY_PASSED" }, silent);
  if (target === "LAUNCH") return;
  await machine.send(mission.id, { type: "LAUNCHED" }, silent);
}

function sourceTimelineEvents(document: ProjectDocument): ProjectDocument["timeline"] {
  return document.timeline.filter((event) => MEANINGFUL_EVENTS.has(event.kind) && event.kind !== "mission.created" && event.kind !== MISSION_HARDWARE_EVENT);
}

export function createProjectFileService(deps: ProjectFileDependencies): ProjectFileService {
  return {
    async export(missionId) {
      const mission = await deps.store.getMission(missionId);
      if (!mission) throw new ProjectFileError(404, "MISSION_NOT_FOUND", "mission not found");
      const revisions = (await deps.store.listRevisions(missionId)).sort((a, b) => a.n - b.n);
      const events = await deps.store.listEvents(missionId);
      const attachments = new Map<string, ProjectAttachment>();
      const chat = exportChat(await deps.messages.list(missionId), attachments);
      const photoArtifacts = new Map<number, ProjectDocument["revisions"][number]["photoArtifacts"]>();
      for (const revision of revisions) {
        const files: NonNullable<ProjectDocument["revisions"][number]["photoArtifacts"]> = [];
        for (const [key, hash] of Object.entries(revision.results.artifacts)) {
          if (!/^photo-(?:step-)?[A-Za-z0-9._-]+$/i.test(key)) continue;
          const artifact = await deps.store.getArtifact(hash);
          if (!artifact) continue;
          const path = `attachments/photo-r${revision.n}-${safeAttachmentPart(key)}`;
          attachments.set(path, { data: artifact.data, contentType: artifact.contentType });
          files.push({ key, path, contentType: artifact.contentType, size: artifact.data.byteLength });
        }
        if (files.length) photoArtifacts.set(revision.n, files);
      }
      const buildRevision = mission.releasedRevision ?? mission.currentRevision ?? null;
      const hardwareData = events.find((event) => event.kind === MISSION_HARDWARE_EVENT)?.data;
      const base: Omit<ProjectDocument, "integrity"> = {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        exportedAt: new Date().toISOString(),
        app: { version: APP_VERSION },
        mission: {
          title: mission.title,
          brief: mission.brief,
          phase: mission.phase,
          ...(mission.currentRevision === undefined ? {} : { currentRevision: mission.currentRevision }),
          ...(mission.releasedRevision === undefined ? {} : { releasedRevision: mission.releasedRevision }),
          inventory: mission.inventory,
          ...(mission.inventoryNotes ? { inventoryNotes: mission.inventoryNotes } : {}),
        },
        revisions: revisions.map((revision) => ({
          n: revision.n,
          hash: revision.hash,
          ...(revision.parent === undefined ? {} : { parent: revision.parent }),
          circuit: revision.circuit,
          ...(revision.suite === undefined ? {} : { suite: revision.suite }),
          author: safeActor(revision.author) as ProjectDocument["revisions"][number]["author"],
          ...(revision.note === undefined ? {} : { note: revision.note }),
          createdAt: revision.createdAt,
          preserved: preservedResults(revision),
          ...(photoArtifacts.has(revision.n) ? { photoArtifacts: photoArtifacts.get(revision.n) } : {}),
        })),
        chat,
        timeline: events.filter(meaningfulEvent).map(exportEvent),
        buildProgress: { revision: buildRevision, done: doneSteps(events, buildRevision) },
        wireColors: buildRevision === null ? {} : wireOverrides(events, buildRevision),
        ...(hardwareData === undefined ? {} : { hardware: safeValue(hardwareData) as MyHardware }),
        attachments: [...attachments.entries()].map(([path, item]) => ({ path, contentType: item.contentType, size: item.data.byteLength, sha256: bytesHash(item.data) })),
      };
      // Hash the validated document, i.e. exactly what's written below (parsing can drop or reorder fields).
      const validated = ProjectSchema.parse(base);
      const document = { ...validated, integrity: jsonHash(validated) };
      const zip: Zippable = { "project.json": strToU8(JSON.stringify(document)) };
      for (const [path, item] of attachments) zip[path] = item.data;
      return { bytes: zipSync(zip), fileName: `${safeName(mission.title)}.vibread` };
    },

    async import(input) {
      const parsed = parsedProject(input.bytes);
      validateDocument(parsed.document);
      const document = parsed.document;
      const currentRevision = document.mission.currentRevision ?? document.revisions.at(-1)?.n;
      const imported = await deps.store.createMission({
        title: document.mission.title,
        brief: document.mission.brief,
        ownerId: input.ownerId,
        inventory: document.mission.inventory as Mission["inventory"],
        ...(document.mission.inventoryNotes ? { inventoryNotes: document.mission.inventoryNotes } : {}),
      });
      try {
        for (const revision of [...document.revisions].sort((a, b) => a.n - b.n)) {
          await deps.store.createRevision(imported.id, {
            circuit: revision.circuit,
            ...(revision.suite ? { suite: revision.suite } : {}),
            author: importedActor(revision.author, `revision-${revision.n}`),
            ...(revision.note ? { note: revision.note } : {}),
            ...(revision.parent === undefined ? {} : { parent: revision.parent }),
          });
          const saved: Partial<RevisionResults> = {};
          const reports = revision.preserved?.reports?.filter(reportLooksUsable) as RevisionResults["reports"] | undefined;
          if (reports?.length) saved.reports = reports;
          if (revision.preserved?.bench) saved.bench = revision.preserved.bench as RevisionResults["bench"];
          if (revision.preserved?.photos) saved.photos = revision.preserved.photos as RevisionResults["photos"];
          if (Object.keys(saved).length) await deps.store.saveResults(imported.id, revision.n, saved);
        }
        await deps.store.updateMission(imported.id, {
          ...(currentRevision === undefined ? {} : { currentRevision }),
          ...(document.mission.releasedRevision === undefined ? {} : { releasedRevision: document.mission.releasedRevision }),
        });
        const restoredMission = await deps.store.getMission(imported.id);
        if (!restoredMission) throw new Error("imported mission disappeared");
        await restorePhase(deps.machine, restoredMission, document.mission.phase ?? (document.mission.releasedRevision === undefined ? "GONOGO" : "ASSEMBLE"));
        if (document.hardware) {
          await deps.store.appendEvent({
            missionId: imported.id,
            channel: "system",
            actor: { kind: "system", id: "imported-hardware", name: "Your hardware", channel: "system" },
            kind: MISSION_HARDWARE_EVENT,
            text: "Hardware restored from imported project",
            data: document.hardware,
          });
        }
        await deps.messages.save(imported.id, importChat(document.chat, parsed.attachments));
        for (const event of sourceTimelineEvents(document)) {
          await deps.store.appendEvent({
            missionId: imported.id,
            channel: event.channel,
            actor: importedTimelineActor(event.actor, event.kind),
            kind: event.kind,
            text: event.text,
            ...(event.revision === undefined ? {} : { revision: event.revision }),
            ...(event.data === undefined ? {} : { data: event.data }),
          });
        }
        const buildRevision = document.buildProgress.revision;
        if (buildRevision !== null && document.buildProgress.done.length && !document.timeline.some((event) => event.kind === BUILD_PROGRESS_EVENT && event.revision === buildRevision)) {
          await deps.store.appendEvent({
            missionId: imported.id,
            channel: "system",
            actor: { kind: "system", id: "imported-build", channel: "system" },
            kind: BUILD_PROGRESS_EVENT,
            text: "Restored build progress",
            revision: buildRevision,
            data: { done: document.buildProgress.done },
          });
        }
        if (buildRevision !== null && Object.keys(document.wireColors).length && !document.timeline.some((event) => event.kind === WIRE_COLOR_EVENT && event.revision === buildRevision)) {
          for (const [key, color] of Object.entries(document.wireColors)) {
            await deps.store.appendEvent({
              missionId: imported.id,
              channel: "system",
              actor: { kind: "system", id: "imported-build", channel: "system" },
              kind: WIRE_COLOR_EVENT,
              text: `${key} restored as ${color}`,
              revision: buildRevision,
              data: { key, color },
            });
          }
        }

        const evaluateAndRestore = async (n: number): Promise<void> => {
          await deps.pipeline.evaluate(imported.id, n, { quiet: true });
          const revision = document.revisions.find((candidate) => candidate.n === n);
          if (!revision) return;
          const after = await deps.store.getRevision(imported.id, n);
          if (!after) return;
          const artifactPatch: Record<string, string> = {};
          for (const photo of revision.photoArtifacts ?? []) {
            const attachment = parsed.attachments.get(photo.path);
            if (!attachment) throw new ProjectFileError(400, "INVALID_PROJECT", INVALID_PROJECT);
            artifactPatch[photo.key] = await deps.store.putArtifact(attachment.data, attachment.contentType);
          }
          const oldRetro = revision.preserved?.reports?.filter(reportLooksUsable).filter((report) => isRecord(report) && report.console === "RETRO") as RevisionResults["reports"] | undefined;
          const reports = oldRetro?.length ? [...after.results.reports.filter((report) => report.console !== "RETRO"), ...oldRetro] : after.results.reports;
          await deps.store.saveResults(imported.id, n, {
            reports,
            ...(revision.preserved?.bench ? { bench: revision.preserved.bench as RevisionResults["bench"] } : {}),
            ...(revision.preserved?.photos ? { photos: revision.preserved.photos as RevisionResults["photos"] } : {}),
            ...(Object.keys(artifactPatch).length ? { artifacts: artifactPatch } : {}),
          });
        };
        if (currentRevision !== undefined) await evaluateAndRestore(currentRevision);
        void (async () => {
          for (const revision of document.revisions) {
            if (revision.n === currentRevision) continue;
            try {
              await evaluateAndRestore(revision.n);
            } catch (error) {
              deps.log?.warn({ error: error instanceof Error ? error.message : String(error), missionId: imported.id, revision: revision.n }, "background project revision evaluation failed");
            }
          }
        })();
        const sourceName = basename(input.fileName || "project.vibread").replace(/[\r\n]/g, "").slice(0, 120) || "project.vibread";
        await deps.store.appendEvent({
          missionId: imported.id,
          channel: "system",
          actor: { kind: "system", id: "import", channel: "system" },
          kind: "project.imported",
          text: `Imported from ${sourceName} — exported ${document.exportedAt} from ViBread ${document.app.version}`,
          revision: currentRevision,
          data: { exportedAt: document.exportedAt, appVersion: document.app.version },
        });
        return { missionId: imported.id };
      } catch (error) {
        deps.deleteMission?.(imported.id);
        throw error;
      }
    },
  };
}

/** Used by tests and routes when a caller has a raw upload but no service yet. */
export function parseProjectFile(bytes: Uint8Array): ParsedProject {
  const parsed = parsedProject(bytes);
  validateDocument(parsed.document);
  return parsed;
}
