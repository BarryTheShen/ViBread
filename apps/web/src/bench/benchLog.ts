/**
 * Flash stages and serial events for the laptop debug log (Settings → Diagnostics, mission log). Entries go through the
 * existing client diagnostics route in small batches: a flash logs a few dozen lines within seconds, and the route is
 * rate-limited, so one request carries every line logged within a short window.
 */

export type BenchLogLevel = "info" | "warn" | "error";
export type BenchLog = (level: BenchLogLevel, message: string, data?: Record<string, unknown>) => void;

export interface BenchLogEntry {
  at: string;
  level: BenchLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const REPORT_PATH = "/api/debug/client-errors";
/** Quiet time before a batch is sent, and the longest a line waits. */
const IDLE_MS = 750;
const MAX_WAIT_MS = 3_000;
/** The route refuses messages over 8000 characters. */
const MAX_MESSAGE_CHARS = 7_000;

function lineOf(entry: BenchLogEntry): string {
  const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
  return `${entry.at.slice(11, 23)} ${entry.level.toUpperCase()} ${entry.message}${data}`;
}

export function createBenchLog(missionId: string, send: typeof fetch = (...args) => fetch(...args)): { log: BenchLog; flush(): Promise<void> } {
  let queue: BenchLogEntry[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  let firstQueuedAt = 0;

  const post = async (entries: BenchLogEntry[], lines: string[]): Promise<void> => {
    const worst = entries.some((entry) => entry.level === "error") ? "error" : entries.some((entry) => entry.level === "warn") ? "warn" : "info";
    const body = {
      message: `Bench serial (${worst}): ${entries.length} event${entries.length === 1 ? "" : "s"}\n${lines.join("\n")}`,
      missionId,
      url: typeof window === "undefined" ? "" : window.location.href,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      bench: entries,
    };
    await send(REPORT_PATH, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
  };

  const flush = async (): Promise<void> => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    const entries = queue;
    queue = [];
    let batch: BenchLogEntry[] = [];
    let lines: string[] = [];
    let size = 0;
    for (const entry of entries) {
      const line = lineOf(entry).slice(0, MAX_MESSAGE_CHARS - 100);
      if (batch.length > 0 && size + line.length + 1 > MAX_MESSAGE_CHARS - 100) {
        await post(batch, lines);
        batch = [];
        lines = [];
        size = 0;
      }
      batch.push(entry);
      lines.push(line);
      size += line.length + 1;
    }
    if (batch.length > 0) await post(batch, lines);
  };

  const log: BenchLog = (level, message, data) => {
    if (level === "error") console.warn(`[bench] ${message}`, data ?? "");
    const now = Date.now();
    if (queue.length === 0) firstQueuedAt = now;
    queue.push({ at: new Date(now).toISOString(), level, message, ...(data === undefined ? {} : { data }) });
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => void flush(), now - firstQueuedAt >= MAX_WAIT_MS ? 0 : IDLE_MS);
  };

  return { log, flush };
}
