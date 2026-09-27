import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_PROFILES, type BoardProfileId } from "@vibread/core";
import { defaultToolchain, uploadCommand } from "@vibread/firmware";

/**
 * Native flashing (issue #20): when the ViBread server runs on the computer the board is plugged into, the bundled
 * arduino-cli uploads with the same avrdude command the Arduino IDE uses, instead of the browser's Web Serial flasher.
 */

/** A serial port arduino-cli sees whose USB ID is one of the board profiles' (genuine Arduino, CH340, FTDI, CP210x). */
export interface BenchPort {
  /** The OS name arduino-cli uploads to: COM3, /dev/ttyUSB0, /dev/cu.usbserial-1410. */
  port: string;
  label: string;
  vid: number;
  pid: number;
  /** The board arduino-cli recognised from the USB ID (genuine boards only; clone bridges match nothing). */
  boardFqbn?: string;
}

export type NativeFlashErrorCode =
  | "port_busy"
  | "port_missing"
  | "permission_denied"
  | "not_in_sync"
  | "wrong_chip"
  | "timeout"
  | "toolchain_missing"
  | "upload_failed";

export interface NativeFlashFailure {
  code: NativeFlashErrorCode;
  message: string;
  hint?: string;
}

export type UploadVerdict = { ok: true } | { ok: false; error: NativeFlashFailure };

export interface ProcessOutcome {
  code: number | null;
  /** stdout and stderr interleaved in arrival order. */
  output: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

export type ProcessRunner = (command: string, args: string[], options: { timeoutMs: number; onLine?: (line: string) => void }) => Promise<ProcessOutcome>;

export type NativeFlashResult =
  | { ok: true; output: string; fqbn: string; durationMs: number }
  | { ok: false; error: NativeFlashFailure; output: string; fqbn: string; durationMs: number };

export const UPLOAD_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 256 * 1024;

/** A request error with the status/code shape the API error handler reports. */
export class NativeFlashError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "NativeFlashError";
  }
}

/** Every USB ID the board profiles list (the Web Serial chooser uses the same set), keyed `vid:pid`. */
export function knownBoardUsb(): Map<string, string> {
  const known = new Map<string, string>();
  for (const profile of Object.values(BOARD_PROFILES)) {
    for (const usb of profile.usb) {
      const key = `${usb.vid}:${usb.pid}`;
      if (!known.has(key)) known.set(key, usb.label);
    }
  }
  return known;
}

function usbNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,4}$/i.test(value)) return undefined;
  return Number.parseInt(value.replace(/^0x/i, ""), 16);
}

/** `arduino-cli board list --format json` → the serial ports with a known Arduino / USB-serial bridge ID. */
export function parseBoardList(stdout: string): BenchPort[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new NativeFlashError(502, "board_list_failed", "arduino-cli board list did not return JSON");
  }
  const detected = typeof parsed === "object" && parsed !== null ? (parsed as { detected_ports?: unknown }).detected_ports : undefined;
  if (!Array.isArray(detected)) return [];
  const known = knownBoardUsb();
  const ports: BenchPort[] = [];
  for (const entry of detected as { port?: { address?: unknown; protocol?: unknown; properties?: Record<string, unknown> }; matching_boards?: { name?: unknown; fqbn?: unknown }[] }[]) {
    const port = entry?.port;
    if (!port || port.protocol !== "serial" || typeof port.address !== "string" || !port.address) continue;
    const vid = usbNumber(port.properties?.vid);
    const pid = usbNumber(port.properties?.pid);
    if (vid === undefined || pid === undefined) continue;
    const usbLabel = known.get(`${vid}:${pid}`);
    if (!usbLabel) continue;
    const board = Array.isArray(entry.matching_boards) ? entry.matching_boards.find((candidate) => typeof candidate?.fqbn === "string") : undefined;
    const name = typeof board?.name === "string" ? board.name : usbLabel;
    ports.push({ port: port.address, label: `${port.address} · ${name}`, vid, pid, ...(typeof board?.fqbn === "string" ? { boardFqbn: board.fqbn } : {}) });
  }
  return ports;
}

export function boardListCommand(): { command: string; args: string[] } {
  const toolchain = defaultToolchain();
  return { command: toolchain.cli, args: ["--config-file", toolchain.config, "board", "list", "--format", "json"] };
}

/** firmware's upload command (bundled arduino-cli, the board profile's FQBN), verbose so avrdude's lines reach the log. */
export function nativeUploadCommand(input: { hexPath: string; port: string; board: BoardProfileId }): { command: string; args: string[] } {
  const upload = uploadCommand(input);
  return { command: upload.command, args: [...upload.args, "--verbose"] };
}

function lastErrorLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.reverse().find((line) => /error|fail|denied|cannot|can't|not/i.test(line)) ?? lines[0];
}

/** Classifies an arduino-cli/avrdude upload from its exit and output (avrdude 6 and 8 wording, Windows/Linux/macOS). */
export function classifyUpload(outcome: Pick<ProcessOutcome, "code" | "output" | "timedOut" | "error">): UploadVerdict {
  const { output } = outcome;
  if (outcome.timedOut) {
    return { ok: false, error: { code: "timeout", message: "The uploader did not finish within 60 seconds.", hint: "Unplug the board, plug it back in, and flash again." } };
  }
  if (outcome.error) {
    const missing = outcome.error.code === "ENOENT" || outcome.error.code === "EACCES";
    return {
      ok: false,
      error: missing
        ? { code: "toolchain_missing", message: "ViBread's Arduino uploader (arduino-cli) is not installed on this computer.", hint: "Run `npm run setup:toolchain`, or restart the desktop app to finish its setup." }
        : { code: "upload_failed", message: `The uploader could not start: ${outcome.error.message}` },
    };
  }
  if (outcome.code === 0) return { ok: true };
  // Only avrdude's port-open line decides these: its banner also says "... does not exist" (a missing ~/.avrduderc), and
  // after a failed sync avrdude 8 still prints "unable to open port … for programmer".
  const openFailure = output.split(/\r?\n/).find((line) => /cannot open port|can't open device|ser_open\(\)/i.test(line));
  if (openFailure && /no such file or directory|cannot find the file specified/i.test(openFailure)) {
    return { ok: false, error: { code: "port_missing", message: "That port is gone: the board is unplugged or its USB connection dropped.", hint: "Plug the board back in, refresh the port list, and flash again." } };
  }
  if (openFailure && /permission denied/i.test(openFailure)) {
    return { ok: false, error: { code: "permission_denied", message: "This computer's user is not allowed to open the serial port.", hint: "On Linux, add yourself to the dialout group (sudo usermod -aG dialout $USER) and log in again." } };
  }
  if (openFailure || /access is denied/i.test(output)) {
    return { ok: false, error: { code: "port_busy", message: "The port is busy: another program is holding it.", hint: "Close the Arduino IDE's Serial Monitor or any other app using the board, then flash again." } };
  }
  if (/stk500_getsync|not in sync|programmer is not responding|stk500_recv|stk500_cmd/i.test(output)) {
    return { ok: false, error: { code: "not_in_sync", message: "The board's bootloader did not answer (not in sync).", hint: "Check the Bootloader profile (clone Nanos often need the old bootloader), unplug anything on pins D0/D1, and try again." } };
  }
  if (/invalid device signature|expected signature|signature .*does not match|device signature = 0x000000|double check chip/i.test(output)) {
    return { ok: false, error: { code: "wrong_chip", message: "The chip on this port is not the ATmega328P this design was built for.", hint: "Check the port and the board type." } };
  }
  const line = lastErrorLine(output);
  return { ok: false, error: { code: "upload_failed", message: line ? `The upload failed: ${line}` : `The uploader exited with code ${String(outcome.code)}.` } };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  // arduino-cli runs avrdude as a child; on Windows only a tree kill releases the COM port avrdude holds.
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
  else child.kill("SIGTERM");
}

/** Runs a command without a shell, streaming whole lines and killing the process tree after `timeoutMs`. */
export const runProcess: ProcessRunner = (command, args, options) => new Promise<ProcessOutcome>((resolvePromise) => {
  let output = "";
  let timedOut = false;
  let settled = false;
  const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const take = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (output.length < MAX_OUTPUT) output += text.slice(0, MAX_OUTPUT - output.length);
    const pieces = `${partial[stream]}${text}`.split(/\r\n|\r|\n/);
    partial[stream] = pieces.pop() ?? "";
    for (const piece of pieces) if (piece.trim()) options.onLine?.(piece);
  };
  child.stdout?.on("data", (chunk: Buffer) => take("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => take("stderr", chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs);
  const finish = (code: number | null, error?: NodeJS.ErrnoException): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const stream of ["stdout", "stderr"] as const) if (partial[stream].trim()) options.onLine?.(partial[stream]);
    resolvePromise({ code, output, timedOut, ...(error ? { error } : {}) });
  };
  child.once("error", (error: NodeJS.ErrnoException) => finish(null, error));
  child.once("close", (code) => finish(code));
});

export interface NativeFlasher {
  listPorts(): Promise<BenchPort[]>;
  /** Uploads `hex` to a port `listPorts()` reports; rejects any other port before running anything. */
  flash(input: { port: string; board: BoardProfileId; hex: string; onLine?: (line: string) => void }): Promise<NativeFlashResult>;
}

export function createNativeFlasher(options: { run?: ProcessRunner; uploadTimeoutMs?: number } = {}): NativeFlasher {
  const run = options.run ?? runProcess;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const busy = new Set<string>();

  const listPorts = async (): Promise<BenchPort[]> => {
    const { command, args } = boardListCommand();
    const outcome = await run(command, args, { timeoutMs: LIST_TIMEOUT_MS });
    if (outcome.error?.code === "ENOENT" || outcome.error?.code === "EACCES") throw new NativeFlashError(503, "toolchain_missing", "ViBread's Arduino uploader (arduino-cli) is not installed on this computer");
    if (outcome.error || outcome.timedOut || outcome.code !== 0) {
      throw new NativeFlashError(502, "board_list_failed", `arduino-cli board list failed: ${outcome.timedOut ? "timed out" : lastErrorLine(outcome.output) ?? outcome.error?.message ?? `exit ${String(outcome.code)}`}`);
    }
    // board list prints its JSON on stdout; warnings (if any) precede it on stderr.
    const start = outcome.output.indexOf("{");
    return parseBoardList(start >= 0 ? outcome.output.slice(start) : outcome.output);
  };

  return {
    listPorts,
    async flash(input) {
      const profile = BOARD_PROFILES[input.board];
      if (!profile) throw new NativeFlashError(400, "INVALID_BOARD", "unknown board profile");
      if (typeof input.port !== "string" || !input.port || input.port.length > 256) throw new NativeFlashError(400, "INVALID_PORT", "port is required");
      const ports = await listPorts();
      if (!ports.some((candidate) => candidate.port === input.port)) {
        throw new NativeFlashError(400, "port_not_listed", `${input.port} is not a connected Arduino port. Refresh the port list and choose one of: ${ports.map((candidate) => candidate.port).join(", ") || "none found"}`);
      }
      if (busy.has(input.port)) throw new NativeFlashError(409, "flash_in_progress", `A flash to ${input.port} is already running`);
      busy.add(input.port);
      const started = Date.now();
      const dir = await mkdtemp(join(tmpdir(), "vibread-flash-"));
      try {
        const hexPath = join(dir, "firmware.hex");
        await writeFile(hexPath, input.hex, "utf8");
        const { command, args } = nativeUploadCommand({ hexPath, port: input.port, board: input.board });
        const outcome = await run(command, args, { timeoutMs: uploadTimeoutMs, onLine: input.onLine });
        const verdict = classifyUpload(outcome);
        const durationMs = Date.now() - started;
        return verdict.ok
          ? { ok: true, output: outcome.output, fqbn: profile.fqbn, durationMs }
          : { ok: false, error: verdict.error, output: outcome.output, fqbn: profile.fqbn, durationMs };
      } finally {
        busy.delete(input.port);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
