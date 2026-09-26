import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const WORKER_SOURCE = String.raw`
import { renderAsync } from "@resvg/resvg-js";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  try {
    const image = await renderAsync(request.svg, {
      fitTo: { mode: "width", value: request.width },
      font: { loadSystemFonts: true, sansSerifFamily: "DejaVu Sans", defaultFontFamily: "DejaVu Sans" },
      textRendering: 2,
      shapeRendering: 2,
    });
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, png: image.asPng().toString("base64") }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: String(error) }) + "\n");
  }
});
`;

const REQUEST_TIMEOUT_MS = 15_000;

type Pending = {
  resolve: (png: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerClient = {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  pending: Map<number, Pending>;
  idleTimer?: NodeJS.Timeout;
};

let worker: WorkerClient | undefined;
let nextRequestId = 1;

function pngOptionsSafeSvg(svg: string): string {
  // resvg 2.6 aborts when a filtered/opacity-only zero-area line is clipped by
  // a focused viewBox. Browser SVG keeps the glow and shadows; PNG uses clear
  // strokes/outlines instead and never sends CSS filters to the native worker.
  return svg
    .replace(/filter\s*:\s*[^;}]+;?/gi, "")
    .replace(/filter\s*=\s*"[^"]*"/gi, "")
    .replace(/(\.rail-tick\s*\{[^}]*)opacity\s*:\s*([^;}]+);?/gi, "$1stroke-opacity:$2;");
}

function rejectPending(client: WorkerClient, error: Error): void {
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  client.pending.clear();
}

function stopWorker(client: WorkerClient, reason: string): void {
  if (client.idleTimer) {
    clearTimeout(client.idleTimer);
    client.idleTimer = undefined;
  }
  if (worker === client) worker = undefined;
  rejectPending(client, new Error(`PNG renderer stopped: ${reason}`));
  if (!client.child.killed) client.child.kill();
}

function scheduleIdleStop(client: WorkerClient): void {
  if (client.pending.size > 0) return;
  clearTimeout(client.idleTimer);
  client.idleTimer = setTimeout(() => stopWorker(client, "idle"), 250);
}

function createWorker(): WorkerClient {
  const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.unref();
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  (child.stderr as unknown as { unref?: () => void }).unref?.();
  const lines = createInterface({ input: child.stdout });
  const client: WorkerClient = { child, lines, pending: new Map() };
  child.stderr.on("data", () => undefined);
  lines.on("line", (line) => {
    let message: { id?: number; ok?: boolean; png?: string; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = client.pending.get(message.id);
    if (!pending) return;
    client.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok && message.png) pending.resolve(new Uint8Array(Buffer.from(message.png, "base64")));
    else pending.reject(new Error(message.error ?? "PNG renderer rejected the SVG"));
    scheduleIdleStop(client);
  });
  child.on("error", (error) => stopWorker(client, error.message));
  // A write to a worker that just died fails asynchronously (EPIPE) as an 'error' event on stdin; unhandled, it would
  // crash the whole server. Treat it like the worker stopping: pending requests reject, the next request starts a new one.
  child.stdin.on("error", (error) => stopWorker(client, error.message));
  child.on("exit", (code, signal) => stopWorker(client, `child exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`));
  return client;
}

function currentWorker(): WorkerClient {
  if (!worker) worker = createWorker();
  return worker;
}

function requestPng(svg: string, width: number): Promise<Uint8Array> {
  const client = currentWorker();
  clearTimeout(client.idleTimer);
  client.idleTimer = undefined;
  const id = nextRequestId++;
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      stopWorker(client, `request ${id} timed out after ${REQUEST_TIMEOUT_MS} ms`);
      reject(new Error(`PNG renderer timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    client.pending.set(id, { resolve, reject, timer });
    try {
      client.child.stdin.write(`${JSON.stringify({ id, svg: pngOptionsSafeSvg(svg), width })}\n`);
    } catch (error) {
      clearTimeout(timer);
      client.pending.delete(id);
      stopWorker(client, error instanceof Error ? error.message : String(error));
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

process.once("exit", () => {
  if (worker && !worker.child.killed) worker.child.kill();
});

/** Render a static ViBread SVG using system fonts in an isolated native worker. */
export function svgToPng(svg: string, width = 1200): Promise<Uint8Array> {
  return requestPng(svg, width);
}
