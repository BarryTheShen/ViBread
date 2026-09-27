#!/usr/bin/env node
// Installs the pinned firmware toolchain: arduino-cli 1.5.1 (per-asset SHA-256) + arduino:avr@1.8.8 + ArduinoJson 7.4.2.
// Hosts: Linux x64/arm64, macOS Intel/Apple silicon, Windows x64. Used by `npm run setup:toolchain` (target .toolchain/)
// and by the desktop app (target <userData>/toolchain) through installToolchain().
// Optional: VIBREAD_TOOLCHAIN_CACHE=<dir> with the arduino-cli archive and/or packages/* archives to skip downloads.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CLI_VERSION = "1.5.1";
export const AVR_CORE = "arduino:avr@1.8.8";
export const ARDUINOJSON = "ArduinoJson@7.4.2";

// From https://github.com/arduino/arduino-cli/releases/download/v1.5.1/1.5.1-checksums.txt
const ASSETS = {
  "linux-x64": { file: `arduino-cli_${CLI_VERSION}_Linux_64bit.tar.gz`, sha256: "28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b" },
  "linux-arm64": { file: `arduino-cli_${CLI_VERSION}_Linux_ARM64.tar.gz`, sha256: "1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62" },
  "darwin-x64": { file: `arduino-cli_${CLI_VERSION}_macOS_64bit.tar.gz`, sha256: "c982e940027996bea9901050e95fae99c59c1dcfee54beedecaf28141e7bf2e7" },
  "darwin-arm64": { file: `arduino-cli_${CLI_VERSION}_macOS_ARM64.tar.gz`, sha256: "cb952e8c1621c95ef5f1d17831c945e3d0ec5973f89c557a7ec8feb9c4f7d4c9" },
  "win32-x64": { file: `arduino-cli_${CLI_VERSION}_Windows_64bit.zip`, sha256: "fabe42e0eb04d00e776a66178299ff95a46c623dbc260f997e58fd514853dd40" },
};

/** Paths of a toolchain installed under `dir`, matching packages/firmware defaultToolchain(). */
export function toolchainPaths(dir, platform = process.platform) {
  return {
    cli: join(dir, "bin", platform === "win32" ? "arduino-cli.exe" : "arduino-cli"),
    config: join(dir, "arduino", "arduino-cli.yaml"),
  };
}

/**
 * Installs (or completes) the toolchain in `dir`. Every step is idempotent and skipped when already done.
 * @param {{ dir: string, onProgress?: (event: { step: string, message: string, fraction?: number }) => void, onLog?: (line: string) => void, signal?: AbortSignal }} options
 */
export async function installToolchain({ dir, onProgress = () => {}, onLog = () => {}, signal }) {
  const target = resolve(dir);
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) throw new Error(`Unsupported host ${key}: use Linux x64/arm64, macOS, or Windows x64.`);
  const paths = toolchainPaths(target);
  const arduinoDir = join(target, "arduino");
  for (const sub of ["bin", "arduino/data", "arduino/downloads/packages", "arduino/user"]) mkdirSync(join(target, sub), { recursive: true });

  const current = existsSync(paths.cli) ? await run(paths.cli, ["version"], { signal }).catch(() => "") : "";
  if (current.includes(CLI_VERSION)) {
    onProgress({ step: "cli", message: `arduino-cli ${CLI_VERSION} already installed`, fraction: 1 });
  } else {
    const archive = join(target, asset.file);
    const cache = process.env.VIBREAD_TOOLCHAIN_CACHE;
    if (cache && existsSync(join(cache, asset.file))) {
      copyFileSync(join(cache, asset.file), archive);
    } else {
      const url = `https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${asset.file}`;
      onProgress({ step: "cli", message: `Downloading arduino-cli ${CLI_VERSION}`, fraction: 0 });
      await download(url, archive, (fraction) => onProgress({ step: "cli", message: `Downloading arduino-cli ${CLI_VERSION}`, fraction }), signal);
    }
    const actual = await sha256File(archive);
    if (actual !== asset.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`${asset.file}: SHA-256 mismatch (expected ${asset.sha256}, got ${actual})`);
    }
    onProgress({ step: "cli", message: "Extracting arduino-cli", fraction: 1 });
    await extract(archive, join(target, "bin"), signal);
    rmSync(archive, { force: true });
    if (!existsSync(paths.cli)) throw new Error(`arduino-cli missing after extracting ${asset.file}`);
  }

  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(
    paths.config,
    [
      "board_manager:",
      "    additional_urls: []",
      "directories:",
      `    data: ${quote(join(arduinoDir, "data"))}`,
      `    downloads: ${quote(join(arduinoDir, "downloads"))}`,
      `    user: ${quote(join(arduinoDir, "user"))}`,
      "",
    ].join("\n"),
  );

  const cache = process.env.VIBREAD_TOOLCHAIN_CACHE;
  if (cache && existsSync(join(cache, "packages"))) {
    for (const name of readdirSync(join(cache, "packages"))) {
      const destination = join(arduinoDir, "downloads", "packages", name);
      if (!existsSync(destination)) copyFileSync(join(cache, "packages", name), destination);
    }
  }

  const cli = (args, step, message) => {
    onProgress({ step, message });
    return run(paths.cli, ["--config-file", paths.config, ...args], { signal, onLog });
  };
  const cores = await cli(["core", "list", "--json"], "core", "Checking Arduino AVR core");
  if (/"id":\s*"arduino:avr"/.test(cores)) {
    onProgress({ step: "core", message: "Arduino AVR core already installed", fraction: 1 });
  } else {
    await cli(["core", "update-index"], "core", "Updating the Arduino board index");
    await cli(["core", "install", AVR_CORE], "core", `Installing ${AVR_CORE} (compiler + avrdude)`);
  }
  const libs = await cli(["lib", "list", "--json"], "library", "Checking libraries");
  if (/"name":\s*"ArduinoJson"/.test(libs)) {
    onProgress({ step: "library", message: "ArduinoJson already installed", fraction: 1 });
  } else {
    await cli(["lib", "update-index"], "library", "Updating the Arduino library index");
    await cli(["lib", "install", ARDUINOJSON], "library", `Installing ${ARDUINOJSON}`);
  }
  onProgress({ step: "done", message: "Arduino toolchain ready", fraction: 1 });
  return paths;
}

async function download(url, destination, onFraction, signal) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (total) onFraction(received / total);
      callback(null, chunk);
    },
  });
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination), { signal });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline((await import("node:fs")).createReadStream(file), hash);
  return hash.digest("hex");
}

// Windows 10+ ships bsdtar in System32 (reads .zip); call it by full path so Git's GNU tar on PATH can't shadow it.
function tarCommand() {
  if (process.platform !== "win32") return "tar";
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

// Runs in the archive's folder with relative names: the toolchain lives under the user's profile, and Windows' bsdtar
// can fail to open paths with characters outside the ANSI code page (e.g. a Chinese or Cyrillic user name).
function extract(archive, into, signal) {
  const name = process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli";
  return run(tarCommand(), ["-xf", basename(archive), "-C", relative(dirname(archive), into), name], { signal, cwd: dirname(archive) });
}

function run(command, args, { signal, onLog, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const lines = (text) => {
      if (onLog) for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      lines(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      lines(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

const invokedDirectly = import.meta.url !== undefined && process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = process.argv[2] ? resolve(process.argv[2]) : join(root, ".toolchain");
  installToolchain({
    dir,
    onProgress: ({ message, fraction }) => {
      if (fraction === undefined || fraction === 0 || fraction === 1) console.log(`» ${message}`);
    },
    onLog: (line) => console.log(`  ${line}`),
  })
    .then(async (paths) => {
      for (const args of [["version"], ["core", "list"], ["lib", "list"]]) {
        console.log(await run(paths.cli, ["--config-file", paths.config, ...args]));
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
