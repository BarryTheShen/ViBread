import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";

/** What CAPCOM may text a linked user about, and their opt-in quiet hours (in their own time zone). */
export interface CapcomPrefs {
  /** Claude's questions (ask_user) with their choices. */
  questions: boolean;
  /** Design ready / NO-GO / a ViBread limit stopped the design / a run failed / a long run finished. */
  designs: boolean;
  /** Bench self-test results, fault alerts, bench prompts and physical-action approvals, launch. */
  bench: boolean;
  quietHours: QuietHours;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", 24-hour, in `timeZone`. */
  start: string;
  end: string;
  /** IANA zone the browser reported (Intl.DateTimeFormat().resolvedOptions().timeZone). */
  timeZone: string;
}

export type CapcomCategory = "questions" | "designs" | "bench";

export const DEFAULT_CAPCOM_PREFS: CapcomPrefs = {
  questions: true,
  designs: true,
  bench: true,
  quietHours: { enabled: false, start: "23:00", end: "07:00", timeZone: "UTC" },
};

export class CapcomPrefsError extends Error {
  readonly status = 400;
  readonly code = "INVALID_CAPCOM_PREFS";
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A partial PUT body over the saved prefs; unknown time zones and malformed times are rejected, never stored. */
export function mergeCapcomPrefs(base: CapcomPrefs, input: unknown): CapcomPrefs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CapcomPrefsError("Send the notification settings as an object.");
  const body = input as Record<string, unknown>;
  const next: CapcomPrefs = { ...base, quietHours: { ...base.quietHours } };
  for (const key of ["questions", "designs", "bench"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new CapcomPrefsError(`${key} must be true or false.`);
    next[key] = body[key];
  }
  if (body.quietHours !== undefined) {
    const quiet = body.quietHours;
    if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) throw new CapcomPrefsError("quietHours must be an object.");
    const q = quiet as Record<string, unknown>;
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== "boolean") throw new CapcomPrefsError("quietHours.enabled must be true or false.");
      next.quietHours.enabled = q.enabled;
    }
    for (const key of ["start", "end"] as const) {
      if (q[key] === undefined) continue;
      if (typeof q[key] !== "string" || !TIME.test(q[key])) throw new CapcomPrefsError(`quietHours.${key} must be HH:MM (24-hour).`);
      next.quietHours[key] = q[key];
    }
    if (q.timeZone !== undefined) {
      if (typeof q.timeZone !== "string" || !validTimeZone(q.timeZone)) throw new CapcomPrefsError(`Unknown time zone ${String(q.timeZone)}.`);
      next.quietHours.timeZone = q.timeZone;
    }
  }
  return next;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since midnight at `now` in `timeZone`. */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** True inside the user's opted-in quiet hours (a window may wrap midnight, e.g. 23:00–07:00). Off → never quiet. */
export function inQuietHours(quiet: QuietHours, now: Date = new Date()): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const local = localMinutes(now, quiet.timeZone);
  return start < end ? local >= start && local < end : local >= start || local < end;
}

export interface QueuedNotice {
  id: string;
  missionId?: string;
  text: string;
  createdAt: number;
}

/** Saved prefs plus the notifications held during quiet hours (persisted: a restart doesn't lose them). */
export interface CapcomPrefStore {
  get(userId: string): CapcomPrefs;
  save(userId: string, prefs: CapcomPrefs): CapcomPrefs;
  enqueue(userId: string, notice: { missionId?: string; text: string }): void;
  /** Users with held notifications. */
  queuedUsers(): string[];
  /** Removes and returns a user's held notifications, oldest first. */
  drain(userId: string): QueuedNotice[];
}

export function createCapcomPrefStore(sqlite: SqliteDatabase): CapcomPrefStore {
  return {
    get(userId) {
      const row = sqlite.prepare('SELECT "json" FROM "capcom_prefs" WHERE "userId" = ?').get(userId) as { json: string } | undefined;
      if (!row) return structuredClone(DEFAULT_CAPCOM_PREFS);
      const saved = JSON.parse(row.json) as Partial<CapcomPrefs>;
      return { ...DEFAULT_CAPCOM_PREFS, ...saved, quietHours: { ...DEFAULT_CAPCOM_PREFS.quietHours, ...saved.quietHours } };
    },
    save(userId, prefs) {
      sqlite
        .prepare('INSERT INTO "capcom_prefs" ("userId", "json", "updatedAt") VALUES (?, ?, ?) ON CONFLICT("userId") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"')
        .run(userId, JSON.stringify(prefs), Date.now());
      return prefs;
    },
    enqueue(userId, notice) {
      sqlite
        .prepare('INSERT INTO "capcom_queue" ("id", "userId", "missionId", "text", "createdAt") VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), userId, notice.missionId ?? null, notice.text, Date.now());
    },
    queuedUsers() {
      return (sqlite.prepare('SELECT DISTINCT "userId" FROM "capcom_queue"').all() as { userId: string }[]).map((row) => row.userId);
    },
    drain(userId) {
      return sqlite.transaction(() => {
        const rows = sqlite.prepare('SELECT "id", "missionId", "text", "createdAt" FROM "capcom_queue" WHERE "userId" = ? ORDER BY "createdAt", rowid').all(userId) as { id: string; missionId: string | null; text: string; createdAt: number }[];
        sqlite.prepare('DELETE FROM "capcom_queue" WHERE "userId" = ?').run(userId);
        return rows.map((row) => ({ id: row.id, ...(row.missionId ? { missionId: row.missionId } : {}), text: row.text, createdAt: row.createdAt }));
      })();
    },
  };
}
