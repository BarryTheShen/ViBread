import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEBUG_AREAS = ["http", "agent", "tool", "model", "pipeline", "bench", "scan", "capcom", "client", "error"] as const;
export type DebugArea = (typeof DEBUG_AREAS)[number];
export type DebugLevel = "debug" | "info" | "warn" | "error";

export interface DebugLog {
  event(missionId: string | null, area: DebugArea, message: string, data?: unknown, level?: DebugLevel): void;
  tail(missionId: string | null, count?: number): string[];
}

const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 4 * 1024;
const VERBOSE_LIMIT = 64 * 1024;
const SECRET_KEY = /^(authorization|cookie|password|secret|api[-_]?key|pair|token|accessToken|refreshToken|idToken)$/i;

export class FileDebugLog implements DebugLog {
  private readonly root: string;
  private readonly verbose: boolean;

  constructor(dataDir: string, verbose = process.env.VIBREAD_DEBUG === "1") {
    this.root = join(dataDir, "logs");
    this.verbose = verbose;
    mkdirSync(join(this.root, "missions"), { recursive: true });
  }

  event(missionId: string | null, area: DebugArea, message: string, data?: unknown, level: DebugLevel = "info"): void {
    const entry = {
      ts: new Date().toISOString(),
      area,
      level,
      message,
      ...(data === undefined ? {} : { data: sanitize(data, this.verbose ? VERBOSE_LIMIT : DEFAULT_LIMIT) }),
    };
    const path = this.pathFor(missionId);
    try {
      mkdirSync(join(this.root, "missions"), { recursive: true });
      if (existsSync(path) && statSync(path).size >= MAX_BYTES) {
        const backup = `${path}.1`;
        try { renameSync(path, backup); } catch { /* another writer rotated it */ }
      }
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never break the request or mission operation.
    }
  }

  tail(missionId: string | null, count = 500): string[] {
    const path = this.pathFor(missionId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(5000, count)));
  }

  private pathFor(missionId: string | null): string {
    if (!missionId) return join(this.root, "server.jsonl");
    const safe = missionId.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.root, "missions", `${safe}.jsonl`);
  }
}

export function createDebugLog(dataDir: string): DebugLog {
  return new FileDebugLog(dataDir);
}

function sanitize(value: unknown, limit: number, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item, limit));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = sanitize(childValue, limit, childKey);
    return result;
  }
  return value;
}
