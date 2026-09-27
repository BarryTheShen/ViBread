import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { serverPath } from "./path-env.js";

export interface DesktopPaths {
  /** Staged server tree (resources/runtime when packaged, apps/desktop/.stage/runtime in development). */
  runtime: string;
  node: string;
  userData: string;
  data: string;
  toolchain: string;
  logs: string;
  /** The user's login-shell PATH, resolved once at startup (see loginShellPath). */
  userPath?: string;
}

export function desktopPaths(): DesktopPaths {
  const runtime = app.isPackaged ? join(process.resourcesPath, "runtime") : join(app.getAppPath(), ".stage", "runtime");
  const userData = app.getPath("userData");
  return {
    runtime,
    node: join(runtime, "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    userData,
    data: join(userData, "data"),
    toolchain: join(userData, "toolchain"),
    logs: join(userData, "logs"),
  };
}

// Development-only variables that would change how the bundled Node or the server behave.
const DROP_ENV = /^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$|NODE_ENV$|npm_|INIT_CWD$|TSX_|PORT$|HOST$|PUBLIC_URL$|DATA_DIR$|APP_VERSION$|GITHUB_SHA$|VIBREAD_BUILT_AT$|VIBREAD_ARDUINO_)/;

/** Environment for every child that runs server code (the server itself and the golden-mission seeder). */
export function childEnv(paths: DesktopPaths, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!DROP_ENV.test(key)) env[key] = value;
  const pathKey = process.platform === "win32" ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path") : "PATH";
  env[pathKey] = serverPath(paths.userPath ?? env[pathKey], homedir(), process.platform);
  const exe = process.platform === "win32" ? ".exe" : "";
  env.DATA_DIR = paths.data;
  env.VIBREAD_ARDUINO_CLI = join(paths.toolchain, "bin", `arduino-cli${exe}`);
  env.VIBREAD_ARDUINO_CONFIG = join(paths.toolchain, "arduino", "arduino-cli.yaml");
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Runs a TypeScript file from the runtime tree with the bundled Node + tsx, exactly like `npm start` runs the server. */
export function spawnRuntime(paths: DesktopPaths, script: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (!existsSync(paths.node)) throw new Error(`bundled Node.js missing at ${paths.node}`);
  return spawn(paths.node, ["--import", "tsx", script, ...args], {
    cwd: paths.runtime,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: own process group so the whole tree (schematic/PNG workers) can be killed together.
    detached: process.platform !== "win32",
  });
}

/** Kills a child and all of its descendants. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Append-mode log file, rotated once it passes 10 MB. */
export function openLog(paths: DesktopPaths, name: string): WriteStream {
  mkdirSync(paths.logs, { recursive: true });
  const file = join(paths.logs, name);
  if (existsSync(file) && statSync(file).size > 10_000_000) renameSync(file, `${file}.1`);
  return createWriteStream(file, { flags: "a" });
}
