import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { WriteStream } from "node:fs";
import { childEnv, killTree, openLog, spawnRuntime, type DesktopPaths } from "./runtime.js";
import { lanIPv4, pickPort } from "./network.js";

export interface ServerInfo {
  port: number;
  /** What the desktop window loads: localhost is a secure context, so Web Serial is available. */
  localUrl: string;
  /** LAN address phones use (QR codes); http://localhost:<port> when the machine has no LAN address. */
  publicUrl: string;
  /** The exact Arduino toolchain paths passed through the server child's environment. */
  arduinoCli: string;
  arduinoConfig: string;
}

const READY_TIMEOUT_MS = 180_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 120_000;

/**
 * Supervises the server child (bundled Node + tsx + server-entry.ts): picks the port, waits for GET /api/me, logs to
 * logs/server.log, restarts it after a crash and kills the whole process tree on stop.
 * Events: "ready" (ServerInfo), "crashed" (message), "failed" (message: gave up restarting).
 */
export class ServerProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private log?: WriteStream;
  private stopping = false;
  private crashes: number[] = [];
  info?: ServerInfo;

  constructor(
    private readonly paths: DesktopPaths,
    private readonly apiKey: () => string | undefined,
  ) {
    super();
  }

  async start(): Promise<ServerInfo> {
    this.stopping = false;
    this.log ??= openLog(this.paths, "server.log");
    const port = await pickPort(this.info?.port ?? (Number(process.env.VIBREAD_PORT) || 8787));
    const lan = lanIPv4();
    const info: ServerInfo = {
      port,
      localUrl: `http://127.0.0.1:${port}`,
      publicUrl: lan ? `http://${lan}:${port}` : `http://localhost:${port}`,
      arduinoCli: "",
      arduinoConfig: "",
    };
    const env = childEnv(this.paths, {
      PORT: String(port),
      HOST: "0.0.0.0",
      // better-auth's MCP plugin only accepts https or loopback resource URLs, so the server's own URL stays on
      // localhost; phones get the LAN origin through VIBREAD_PHONE_URL.
      PUBLIC_URL: `http://localhost:${port}`,
      VIBREAD_PHONE_URL: info.publicUrl,
      VIBREAD_RUNTIME: "desktop",
      ANTHROPIC_API_KEY: this.apiKey() ?? process.env.ANTHROPIC_API_KEY,
      NODE_ENV: "production",
    });
    info.arduinoCli = env.VIBREAD_ARDUINO_CLI ?? "";
    info.arduinoConfig = env.VIBREAD_ARDUINO_CONFIG ?? "";
    this.write(`\n=== ${new Date().toISOString()} starting server on ${info.localUrl} (public ${info.publicUrl})\n`);
    const child = spawnRuntime(this.paths, "server-entry.ts", [], env);
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.write(chunk));
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<string>();
    child.once("error", (error) => resolveExit(`could not start: ${error.message}`));
    child.once("exit", (code, signal) => resolveExit(`exited with ${signal ?? `code ${code}`}`));
    void exited.then((reason) => this.onExit(child, reason));
    await Promise.race([
      this.waitReady(info.localUrl),
      exited.then((reason) => Promise.reject(new Error(`server ${reason} before it was ready (see logs/server.log)`))),
    ]);
    this.info = info;
    this.emit("ready", info);
    return info;
  }

  /** Graceful shutdown (stdin close → server.close() → exit hooks stop workers), then a hard tree kill. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    try {
      child.stdin.write("shutdown\n");
      child.stdin.end();
    } catch {
      // stdin already closed
    }
    const timedOut = await Promise.race([exited.then(() => false), sleep(6_000, true)]);
    // Grandchildren (schematic/PNG workers) exit with the server; the tree kill covers anything that did not.
    if (child.pid !== undefined) killTree(child.pid);
    if (timedOut) await Promise.race([exited, sleep(2_000)]);
  }

  async restart(): Promise<ServerInfo> {
    await this.stop();
    return this.start();
  }

  private onExit(child: ChildProcessWithoutNullStreams, reason: string): void {
    this.write(`=== ${new Date().toISOString()} server ${reason}\n`);
    if (child !== this.child || this.stopping || !this.info) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((at) => now - at < RESTART_WINDOW_MS), now];
    if (this.crashes.length > MAX_RESTARTS) {
      this.emit("failed", `The ViBread server keeps crashing (${reason}).`);
      return;
    }
    this.emit("crashed", reason);
    setTimeout(() => {
      this.start().catch((error: Error) => this.emit("failed", error.message));
    }, 1_000 * this.crashes.length);
  }

  private async waitReady(url: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ok = await fetch(`${url}/api/me`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`server did not answer ${url}/api/me within ${READY_TIMEOUT_MS / 1000} s`);
  }

  private write(chunk: string | Buffer): void {
    this.log?.write(chunk);
  }
}
