import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPaths } from "./runtime.js";
import { pickPort } from "./network.js";
import { ServerProcess } from "./server.js";

vi.mock("electron", () => ({ app: {} }));

const REPO_NODE_MODULES = resolve(__dirname, "../../../node_modules");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A runtime tree whose server-entry.ts is `entry`, run by this Node with the repo's tsx (like the staged runtime). */
function fakeRuntime(entry: string): DesktopPaths {
  const root = mkdtempSync(join(tmpdir(), "vb-desktop-server-"));
  const runtime = join(root, "runtime");
  mkdirSync(runtime);
  symlinkSync(REPO_NODE_MODULES, join(runtime, "node_modules"));
  writeFileSync(join(runtime, "server-entry.ts"), entry);
  const userData = join(root, "user data");
  return { runtime, node: process.execPath, userData, data: join(userData, "data"), toolchain: join(userData, "toolchain"), logs: join(userData, "logs") };
}

describe("ServerProcess", () => {
  let paths: DesktopPaths | undefined;
  let server: ServerProcess | undefined;
  const savedPort = process.env.VIBREAD_PORT;
  beforeEach(() => {
    // Never probe the dev server's 8787.
    process.env.VIBREAD_PORT = String(20_000 + Math.floor(Math.random() * 20_000));
  });
  afterEach(async () => {
    await server?.stop();
    if (paths) rmSync(join(paths.runtime, ".."), { recursive: true, force: true });
    if (savedPort === undefined) delete process.env.VIBREAD_PORT;
    else process.env.VIBREAD_PORT = savedPort;
    paths = server = undefined;
  });

  it("fails start() with the end of the server's output when it exits before it is ready", async () => {
    paths = fakeRuntime(`console.error("Error: The module 'better_sqlite3.node' was compiled against a different Node.js version"); process.exit(1);\n`);
    server = new ServerProcess(paths, () => undefined);
    const failure = server.start();
    await expect(failure).rejects.toThrow(/exited with code 1 before it was ready/);
    await expect(failure).rejects.toThrow(/better_sqlite3\.node' was compiled against a different Node\.js version/);
  });

  it("is ready only after the child's own ready line, even when /api/me already answers", async () => {
    // A real child process on the real clock (fake timers can't reach it): it answers /api/me at once but announces
    // itself 1 s later. Polling /api/me alone (every 250 ms) calls it ready well before that.
    paths = fakeRuntime(`
      import { createServer } from "node:http";
      const server = createServer((_req, res) => res.end("{}")).listen(Number(process.env.PORT), "127.0.0.1");
      server.on("listening", () => setTimeout(() => console.log("VIBREAD_SERVER_READY port=" + process.env.PORT), 1000));
      process.stdin.on("end", () => process.exit(0)).resume();
    `);
    server = new ServerProcess(paths, () => undefined);
    const started = Date.now();
    const info = await server.start();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(info.localUrl).toBe(`http://127.0.0.1:${info.port}`);
    expect(await (await fetch(`${info.localUrl}/api/me`)).text()).toBe("{}");
  }, 20_000);

  it.runIf(process.platform !== "win32")("stop() leaves no orphaned grandchildren (arduino-cli, workers) behind", async () => {
    paths = fakeRuntime(`
      import { spawn } from "node:child_process";
      import { createServer } from "node:http";
      import { writeFileSync } from "node:fs";
      const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync("grandchild.pid", String(worker.pid));
      createServer((_req, res) => res.end("{}")).listen(Number(process.env.PORT), "0.0.0.0", () => console.log("VIBREAD_SERVER_READY port=" + process.env.PORT));
      // Exits without stopping its child, like a server whose close() hook never reached a running arduino-cli.
      process.stdin.on("end", () => process.exit(0)).resume();
    `);
    server = new ServerProcess(paths, () => undefined);
    await server.start();
    const grandchild = Number(readFileSync(join(paths.runtime, "grandchild.pid"), "utf8"));
    expect(alive(grandchild)).toBe(true);
    await server.stop();
    // SIGKILL delivery is asynchronous: wait (bounded) for the process to disappear.
    for (let i = 0; i < 20 && alive(grandchild); i += 1) await sleep(100);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);
});

describe("pickPort", () => {
  let holder: Server | undefined;
  afterEach(() => holder?.close());

  it("skips a port another program holds on 127.0.0.1 only", async () => {
    holder = createServer();
    const held = await new Promise<number>((resolvePort) => holder!.listen(0, "127.0.0.1", () => resolvePort((holder!.address() as { port: number }).port)));
    const picked = await pickPort(held);
    expect(picked).not.toBe(held);
    expect(picked).toBeGreaterThan(0);
  });
});
