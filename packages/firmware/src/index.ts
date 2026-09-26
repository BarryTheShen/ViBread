import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import {
  BOARD_PROFILES,
  boardPin,
  SELFTEST_LIMITS,
  type BoardPin,
  type BoardProfile,
  type BoardProfileId,
  type CompileDiagnostic,
  type CompileResult,
  type SelfTestPlan,
  type SelfTestSubject,
} from "@vibread/core";

export interface ToolchainPaths {
  cli: string;
  config: string;
}

const SKETCH_NAME = "ViBreadSketch";
const USER_SKETCH_FILE = "sketch.ino";
const LOG_LIMIT = 8_192;
const MAX_CAPTURE = 4 * 1024 * 1024;
const COMPILE_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const TEMPLATE_PATH = fileURLToPath(new URL("../templates/bench.ino.eta", import.meta.url));

interface CompileJob {
  run: () => Promise<CompileResult>;
  resolve: (result: CompileResult) => void;
  reject: (error: unknown) => void;
}

const compileQueue: CompileJob[] = [];
let activeCompiles = 0;

function pumpCompileQueue(): void {
  while (activeCompiles < COMPILE_CONCURRENCY && compileQueue.length > 0) {
    const job = compileQueue.shift();
    if (!job) return;
    activeCompiles += 1;
    void job.run().then(job.resolve, job.reject).finally(() => {
      activeCompiles -= 1;
      pumpCompileQueue();
    });
  }
}

function enqueueCompile(run: () => Promise<CompileResult>): Promise<CompileResult> {
  return new Promise<CompileResult>((resolvePromise, reject) => {
    compileQueue.push({ run, resolve: resolvePromise, reject });
    pumpCompileQueue();
  });
}

export function defaultToolchain(): ToolchainPaths {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  return {
    cli: process.env.VIBREAD_ARDUINO_CLI ?? join(root, ".toolchain", "bin", process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli"),
    config: process.env.VIBREAD_ARDUINO_CONFIG ?? join(root, ".toolchain", "arduino", "arduino-cli.yaml"),
  };
}

function failedResult(profile: BoardProfile, diagnostics: CompileDiagnostic[], log: string, durationMs = 0): CompileResult {
  return {
    ok: false,
    fqbn: profile.fqbn,
    diagnostics,
    durationMs,
    log: truncate(log),
  };
}

function truncate(value: string): string {
  if (value.length <= LOG_LIMIT) return value;
  return `${value.slice(0, LOG_LIMIT - 1)}\n`;
}

function macroName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid calibration macro name: ${name}`);
  return name;
}

function macroValue(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Calibration macro values must be finite numbers");
  return String(value);
}

/** Prefixes guarded sketch defaults with compile-time calibration values. */
export function applyCalibration(source: string, macros: Record<string, number>): string {
  const lines = Object.entries(macros)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `#define ${macroName(name)} ${macroValue(value)}`);
  return lines.length === 0 ? source : `${lines.join("\n")}\n${source}`;
}

function applyDefines(source: string, defines: Record<string, number | string> | undefined): { source: string; prefixLines: number } {
  if (!defines || Object.keys(defines).length === 0) return { source, prefixLines: 0 };
  const numeric: Record<string, number> = {};
  const textual: string[] = [];
  for (const [rawName, rawValue] of Object.entries(defines)) {
    const name = macroName(rawName);
    if (typeof rawValue === "number") {
      numeric[name] = rawValue;
      continue;
    }
    const value = rawValue.trim();
    if (value.length === 0 || /[\r\n;{}#]/.test(value)) {
      throw new Error(`Invalid define value for ${name}`);
    }
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) {
      textual.push(`#define ${name} ${value}`);
    } else {
      numeric[name] = Number(value);
    }
  }
  const calibrated = applyCalibration(source, numeric);
  const text = textual.length > 0 ? `${textual.join("\n")}\n` : "";
  return { source: `${text}${calibrated}`, prefixLines: textual.length + Object.keys(numeric).length };
}

const UNSAFE_INCLUDE_MESSAGE = "The sketch may only include standard Arduino and library headers (e.g. <Arduino.h>, <Servo.h>).";
const UNSAFE_ASM_MESSAGE = "Inline assembly isn't allowed in ViBread sketches.";

interface SourceLine {
  text: string;
  originalLine: number;
}

function spliceSourceLines(source: string): { text: string; lineOrigins: number[] } {
  let text = "";
  let originalLine = 1;
  const lineOrigins = [1];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "\n") {
      originalLine += 1;
      index += 1;
      continue;
    }
    if (character === "\\" && source[index + 1] === "\r" && source[index + 2] === "\n") {
      originalLine += 1;
      index += 2;
      continue;
    }
    text += character;
    if (character === "\n") {
      originalLine += 1;
      lineOrigins.push(originalLine);
    }
  }
  return { text, lineOrigins };
}

function stripSourceComments(source: string): string {
  let output = "";
  let state: "normal" | "string" | "char" = "normal";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "normal") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        while (index + 1 < source.length) {
          index += 1;
          if (source[index] === "*" && source[index + 1] === "/") {
            output += "  ";
            index += 1;
            break;
          }
          output += source[index] === "\n" ? "\n" : " ";
        }
        continue;
      }
      if (character === "\"") state = "string";
      else if (character === "'") state = "char";
      output += character;
      continue;
    }
    output += character;
    if (character === "\\") {
      if (index + 1 < source.length) {
        output += source[index + 1];
        index += 1;
      }
      continue;
    }
    if ((state === "string" && character === "\"") || (state === "char" && character === "'")) state = "normal";
  }
  return output;
}

function unsafeSketchSource(source: string): { line: number; message: string } | undefined {
  const spliced = spliceSourceLines(source);
  const normalized = stripSourceComments(spliced.text).replace(/%:/g, "#").replace(/\?\?=/g, "#");
  const lines: SourceLine[] = normalized.split(/\n/).map((text, index) => ({ text, originalLine: spliced.lineOrigins[index] ?? index + 1 }));
  const includeName = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.(?:h|hpp)$/;
  const includeDirective = /^\s*#\s*(include_next|import|include)\b(.*)$/i;
  const lineDirective = /^\s*#\s*line\b/i;
  const dependencyDirective = /^\s*#\s*pragma\s+GCC\s+dependency\b/i;
  const asmToken = /\b(?:asm|__asm|__asm__)\b/;
  const splitIncbin = /[\"']\s*\.?\s*inc\s*[\"']\s*[\"']\s*bin\s*[\"']/i;
  for (const line of lines) {
    const directive = line.text.match(includeDirective);
    if (directive) {
      if (directive[1].toLowerCase() !== "include") return { line: line.originalLine, message: UNSAFE_INCLUDE_MESSAGE };
      const argument = directive[2].trim();
      const angle = argument.match(/^<([^<>]*)>$/);
      const quoted = argument.match(/^\"([^\"]*)\"$/);
      if (!angle && !quoted) return { line: line.originalLine, message: UNSAFE_INCLUDE_MESSAGE };
      const header = (angle ?? quoted)?.[1] ?? "";
      if (!includeName.test(header)) return { line: line.originalLine, message: UNSAFE_INCLUDE_MESSAGE };
    }
    if (lineDirective.test(line.text) && /[\"<>/\\\\]/.test(line.text)) return { line: line.originalLine, message: UNSAFE_INCLUDE_MESSAGE };
    if (dependencyDirective.test(line.text) || /\b__has_include(?:_next)?\b/.test(line.text)) return { line: line.originalLine, message: UNSAFE_INCLUDE_MESSAGE };
    if (asmToken.test(line.text) || /\bincbin\b|\.include\b/i.test(line.text) || splitIncbin.test(line.text)) {
      return { line: line.originalLine, message: UNSAFE_ASM_MESSAGE };
    }
  }
  return undefined;
}

function mapGeneratedFile(file: unknown): string | undefined {
  if (typeof file !== "string" || file.length === 0) return undefined;
  const name = basename(file);
  if (name.startsWith(`${SKETCH_NAME}.ino`) || name.endsWith(".ino.cpp") || name === SKETCH_NAME) return USER_SKETCH_FILE;
  return file;
}

function mapGeneratedLine(line: unknown, prefixLines: number): number | undefined {
  if (typeof line !== "number" || !Number.isFinite(line)) return undefined;
  const mapped = Math.trunc(line) - prefixLines;
  return mapped > 0 ? mapped : undefined;
}

function normalizeSeverity(value: unknown): CompileDiagnostic["severity"] {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("warning")) return "warning";
  if (text.includes("note")) return "note";
  return "error";
}

function structuredDiagnostics(parsed: Record<string, unknown>, prefixLines: number): CompileDiagnostic[] {
  const builder = parsed.builder_result;
  const candidates: unknown[] = [];
  if (builder && typeof builder === "object") {
    const diagnostics = (builder as Record<string, unknown>).diagnostics;
    if (Array.isArray(diagnostics)) candidates.push(...diagnostics);
  }
  if (Array.isArray(parsed.diagnostics)) candidates.push(...parsed.diagnostics);
  const result: CompileDiagnostic[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const message = typeof item.message === "string" ? item.message : typeof item.context === "string" ? item.context : "Compiler diagnostic";
    result.push({
      severity: normalizeSeverity(item.severity),
      file: mapGeneratedFile(item.file),
      line: mapGeneratedLine(item.line, prefixLines),
      column: typeof item.column === "number" ? Math.trunc(item.column) : undefined,
      message,
    });
  }
  return result;
}

function gccDiagnostics(output: string, prefixLines: number): CompileDiagnostic[] {
  const result: CompileDiagnostic[] = [];
  const pattern = /^(.*?):(\d+)(?::(\d+))?:\s*(warning|error|note):\s*(.*)$/i;
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(pattern);
    if (!match) continue;
    const mappedLine = mapGeneratedLine(Number(match[2]), prefixLines);
    result.push({
      severity: normalizeSeverity(match[4]),
      file: mapGeneratedFile(match[1]),
      line: mappedLine,
      column: match[3] ? Number(match[3]) : undefined,
      message: match[5].trim(),
    });
  }
  return result;
}

function parseJsonOutput(stdout: string): Record<string, unknown> | undefined {
  const raw = stdout.trim();
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // Arduino CLI normally emits one object, but diagnostics or wrappers can add lines around it.
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let fallback: Record<string, unknown> | undefined;
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") continue;
        const object = parsed as Record<string, unknown>;
        if ("success" in object || "builder_result" in object) return object;
        fallback ??= object;
      } catch {
        // Continue to the bounded substring fallback below.
      }
    }
    if (fallback) return fallback;
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const parsed: unknown = JSON.parse(raw.slice(first, last + 1));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function sectionsSize(parsed: Record<string, unknown>): CompileResult["sizes"] {
  const builder = parsed.builder_result;
  if (!builder || typeof builder !== "object") return undefined;
  const raw = (builder as Record<string, unknown>).executable_sections_size;
  if (!Array.isArray(raw)) return undefined;
  let text = 0;
  let data = 0;
  let bss = 0;
  let flashMax: number | undefined;
  let ramMax: number | undefined;
  for (const section of raw) {
    if (!section || typeof section !== "object") continue;
    const item = section as Record<string, unknown>;
    const name = String(item.name ?? "").toLowerCase();
    const size = typeof item.size === "number" ? item.size : 0;
    const max = typeof item.max_size === "number" ? item.max_size : undefined;
    if (name === "text" || name === "rodata") text += size;
    if (name === "data") data += size;
    if (name === "bss") bss += size;
    if (name === "text" && max !== undefined) flashMax = max;
    if ((name === "data" || name === "bss") && max !== undefined) ramMax = max;
  }
  if (flashMax === undefined || ramMax === undefined) return undefined;
  return { flashBytes: text + data, flashMax, ramBytes: data + bss, ramMax };
}

function compileTimeoutMs(): number {
  const configured = Number(process.env.VIBREAD_COMPILE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(Math.trunc(configured), 15 * 60_000) : DEFAULT_TIMEOUT_MS;
}

interface ProcessCapture {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  aborted: boolean;
  timedOut: boolean;
}

function runArduino(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<ProcessCapture> {
  return new Promise<ProcessCapture>((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ code: null, signal: "SIGTERM", stdout: "", stderr: "", aborted: true, timedOut: false });
      return;
    }
    const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      if (target === "stdout") stdout = `${stdout}${text}`.slice(0, MAX_CAPTURE);
      else stderr = `${stderr}${text}`.slice(0, MAX_CAPTURE);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, compileTimeoutMs());
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({ code: null, signal: null, stdout, stderr, error, aborted, timedOut });
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({ code, signal: childSignal, stdout, stderr, aborted, timedOut });
    });
  });
}

async function compileSource(source: string, profile: BoardProfile, signal?: AbortSignal, prefixLines = 0): Promise<CompileResult> {
  const started = Date.now();
  const jobRoot = await mkdtemp(join(tmpdir(), process.env.VIBREAD_JOB_PREFIX ?? "vibread-firmware-"));
  try {
    const sketchDir = join(jobRoot, SKETCH_NAME);
    const outputDir = join(jobRoot, "output");
    const buildPath = join(jobRoot, "build");
    await Promise.all([mkdir(sketchDir, { recursive: true }), mkdir(outputDir, { recursive: true }), mkdir(buildPath, { recursive: true })]);
    await writeFile(join(sketchDir, `${SKETCH_NAME}.ino`), source, "utf8");
    const toolchain = defaultToolchain();
    const args = [
      toolchain.cli,
      "--config-file",
      toolchain.config,
      "compile",
      "--fqbn",
      profile.fqbn,
      "--warnings",
      "all",
      "--json",
      "--output-dir",
      outputDir,
      "--build-path",
      buildPath,
      sketchDir,
    ];
    const processResult = await runArduino(args, jobRoot, signal);
    const durationMs = Date.now() - started;
    const combined = `${processResult.stdout}\n${processResult.stderr}`;
    if (processResult.aborted || processResult.timedOut) {
      const reason = processResult.aborted ? "Compilation aborted" : "Compilation timed out";
      return failedResult(profile, [{ severity: "error", message: reason }], combined, durationMs);
    }
    if (processResult.error) {
      return failedResult(profile, [{ severity: "error", message: processResult.error.message }], combined, durationMs);
    }
    const parsed = parseJsonOutput(processResult.stdout);
    const compilerOut = parsed && typeof parsed.compiler_out === "string" ? parsed.compiler_out : "";
    const compilerErr = parsed && typeof parsed.compiler_err === "string" ? parsed.compiler_err : "";
    const diagnostics = parsed ? structuredDiagnostics(parsed, prefixLines) : [];
    diagnostics.push(...gccDiagnostics(`${compilerOut}\n${compilerErr}\n${processResult.stderr}`, prefixLines));
    const parsedError = parsed && typeof parsed.error === "string" ? parsed.error : undefined;
    const successFlag = parsed?.success === true;
    if (!parsed) {
      diagnostics.push({ severity: "error", message: processResult.stderr.trim() || "arduino-cli returned invalid JSON" });
    } else if (!successFlag && parsedError && !diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      diagnostics.push({ severity: "error", message: parsedError });
    }
    if ((!successFlag || processResult.code !== 0) && !diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      diagnostics.push({ severity: "error", message: processResult.code === null ? "arduino-cli did not exit normally" : `arduino-cli exited with status ${processResult.code}` });
    }
    const normalizedMessage = (message: string): string => message.split(/\r?\n/)[0].replace(/\\+/g, "\\").replace(/\s+/g, " ").trim();
    const uniqueDiagnostics = diagnostics.filter((item, index, all) => index === all.findIndex((other) => other.severity === item.severity && other.file === item.file && other.line === item.line && normalizedMessage(other.message) === normalizedMessage(item.message)));
    const sizes = parsed ? sectionsSize(parsed) : undefined;
    const hexPath = join(outputDir, `${SKETCH_NAME}.ino.hex`);
    const builtElfPath = join(outputDir, `${SKETCH_NAME}.ino.elf`);
    const hasHex = existsSync(hexPath);
    const hasElf = existsSync(builtElfPath);
    const ok = successFlag && processResult.code === 0 && hasHex && hasElf;
    if (successFlag && !hasHex) uniqueDiagnostics.push({ severity: "error", message: "arduino-cli reported success but did not produce the application HEX" });
    if (successFlag && !hasElf) uniqueDiagnostics.push({ severity: "error", message: "arduino-cli reported success but did not produce the ELF" });
    let hex: string | undefined;
    if (ok) hex = await readFile(hexPath, "utf8");
    const log = [compilerOut, compilerErr, processResult.stderr].filter(Boolean).join("\n");
    return {
      ok,
      fqbn: profile.fqbn,
      hex,
      sizes,
      diagnostics: uniqueDiagnostics,
      durationMs,
      log: truncate(log || combined),
    };
  } finally {
    await rm(jobRoot, { recursive: true, force: true });
  }
}

export function compileSketch(input: {
  source: string;
  board: BoardProfileId;
  defines?: Record<string, number | string>;
  signal?: AbortSignal;
}): Promise<CompileResult> {
  const profile = BOARD_PROFILES[input.board];
  if (!profile) {
    return Promise.resolve({
      ok: false,
      fqbn: "",
      diagnostics: [{ severity: "error", message: `Unknown board profile: ${String(input.board)}` }],
      durationMs: 0,
      log: "",
    });
  }
  const unsafeInput = unsafeSketchSource(input.source);
  if (unsafeInput) {
    return Promise.resolve(failedResult(profile, [{ severity: "error", file: USER_SKETCH_FILE, line: unsafeInput.line, message: unsafeInput.message }], ""));
  }
  let prepared: { source: string; prefixLines: number };
  try {
    prepared = applyDefines(input.source, input.defines);
  } catch (error) {
    return Promise.resolve(failedResult(profile, [{ severity: "error", message: error instanceof Error ? error.message : String(error) }], ""));
  }
  const unsafePrepared = unsafeSketchSource(prepared.source);
  if (unsafePrepared) {
    return Promise.resolve(failedResult(profile, [{ severity: "error", file: USER_SKETCH_FILE, line: Math.max(1, unsafePrepared.line - prepared.prefixLines), message: unsafePrepared.message }], ""));
  }
  return enqueueCompile(() => compileSource(prepared.source, profile, input.signal, prepared.prefixLines));
}

function validatePlan(plan: SelfTestPlan): BoardProfile {
  if (plan.schema !== "vibread.selftest/1") throw new Error("Unsupported self-test plan schema");
  const profile = BOARD_PROFILES[plan.board];
  if (!profile) throw new Error(`Unknown board profile: ${String(plan.board)}`);
  const timing = plan.timing;
  if (!Number.isInteger(timing.ledOnMs) || timing.ledOnMs < 0 || timing.ledOnMs > SELFTEST_LIMITS.ledOnMsMax) {
    throw new Error(`ledOnMs exceeds SELFTEST_LIMITS.ledOnMsMax (${SELFTEST_LIMITS.ledOnMsMax} ms)`);
  }
  if (!Number.isInteger(timing.ledPeriodMs) || timing.ledPeriodMs <= 0 || timing.ledOnMs > timing.ledPeriodMs) {
    throw new Error("ledPeriodMs must be a positive integer no shorter than ledOnMs");
  }
  if (timing.ledOnMs / timing.ledPeriodMs > SELFTEST_LIMITS.dutyMax) {
    throw new Error(`LED duty exceeds SELFTEST_LIMITS.dutyMax (${SELFTEST_LIMITS.dutyMax * 100}%)`);
  }
  if (!Number.isInteger(timing.ledPulses) || timing.ledPulses <= 0) throw new Error("ledPulses must be a positive integer");
  if (!Number.isInteger(timing.promptTimeoutMs) || timing.promptTimeoutMs <= 0) throw new Error("promptTimeoutMs must be a positive integer");
  if (!Number.isInteger(timing.samples) || timing.samples <= 0 || timing.samples > 65_535) throw new Error("samples must be an integer from 1 to 65535");
  const testSet = new Set<string>([
    "rails.vcc",
    "pins.readonly",
    "digital.stuck",
    "button.interactive",
    "light.relative",
    "pot.sweep",
    "led.sequence",
    "buzzer.confirm",
    "net.continuity",
  ]);
  for (const test of plan.tests) if (!testSet.has(test)) throw new Error(`Unknown self-test: ${test}`);
  if (plan.tests[0] !== "rails.vcc" || plan.tests[1] !== "pins.readonly") throw new Error("Self-test order must start with rails.vcc and pins.readonly");
  const seenOrders = new Set<number>();
  for (const subject of plan.subjects) {
    const pin = boardPin(profile, subject.pin);
    if (!pin || pin.arduino === undefined) throw new Error(`Subject ${subject.part} references unknown board pin ${subject.pin}`);
    if (subject.kind === "led") {
      if (!pin.digital || pin.port === undefined || pin.bit === undefined) throw new Error(`LED ${subject.part} requires a digital AVR pin`);
      if (!Number.isInteger(subject.order) || subject.order < 1 || seenOrders.has(subject.order)) throw new Error("LED order values must be unique positive integers");
      seenOrders.add(subject.order);
    } else if (subject.kind === "button" || subject.kind === "buzzer" || subject.kind === "digital-in") {
      if (!pin.digital) throw new Error(`${subject.kind} ${subject.part} requires a digital pin`);
    } else if (subject.kind === "light" || subject.kind === "pot" || subject.kind === "analog-in") {
      if (pin.adc === undefined) throw new Error(`${subject.kind} ${subject.part} requires an analog pin`);
    }
  }
  return profile;
}

function cppString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}


function pinIdentifier(pin: string): string {
  return pin.replace(/[^A-Za-z0-9_]/g, "_");
}

function subjectPin(subject: SelfTestSubject, profile: BoardProfile): BoardPin {
  const pin = boardPin(profile, subject.pin);
  if (!pin || pin.arduino === undefined) throw new Error(`Unknown pin ${subject.pin}`);
  return pin;
}

function subjectByKind<K extends SelfTestSubject["kind"]>(
  plan: SelfTestPlan,
  kind: K,
): Extract<SelfTestSubject, { kind: K }>[] {
  return plan.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: K }> => subject.kind === kind);
}

function valueExpr(pin: BoardPin): string {
  return pin.adc !== undefined && !pin.digital ? `(analogRead(${pin.arduino}) > 512 ? 1 : 0)` : `(digitalRead(${pin.arduino}) == HIGH ? 1 : 0)`;
}

function makePinHelpers(plan: SelfTestPlan, profile: BoardProfile): string {
  const byPin = new Map<string, BoardPin>();
  for (const subject of plan.subjects) byPin.set(subject.pin, subjectPin(subject, profile));
  const snippets: string[] = [];
  for (const [pinName, pin] of byPin) {
    const id = pinIdentifier(pinName);
    snippets.push(`static bool vbStuck_${id} = false;`);
    snippets.push(`static uint8_t vbRead_${id}() { return ${valueExpr(pin)}; }`);
    snippets.push(`static void vbInput_${id}(uint8_t pull) { pinMode(${pin.arduino}, pull ? INPUT_PULLUP : INPUT); if (!pull) digitalWrite(${pin.arduino}, LOW); }`);
    snippets.push(`static void vbDrive_${id}(uint8_t level) { pinMode(${pin.arduino}, OUTPUT); digitalWrite(${pin.arduino}, level ? HIGH : LOW); }`);
    snippets.push(`static void vbPulse_${id}(uint8_t level, uint16_t onMs) { if (vbStuck_${id}) return; vbDrive_${id}(level); delay(onMs > 0 ? onMs - 1 : 0); vbInput_${id}(0); }`);
    if (pin.port !== undefined && pin.bit !== undefined) {
      snippets.push(`static uint8_t vbProbe_${id}(uint8_t drive) { uint8_t savedSreg = SREG; cli(); if (drive) PORT${pin.port} |= _BV(${pin.bit}); else PORT${pin.port} &= (uint8_t)~_BV(${pin.bit}); DDR${pin.port} |= _BV(${pin.bit}); uint8_t readback = (PIN${pin.port} & _BV(${pin.bit})) ? 1 : 0; DDR${pin.port} &= (uint8_t)~_BV(${pin.bit}); PORT${pin.port} &= (uint8_t)~_BV(${pin.bit}); SREG = savedSreg; return readback; }`);
    }
  }
  return snippets.join("\n");
}

function makeSafeIdle(profile: BoardProfile): string {
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const pin of profile.pins) {
    if (pin.arduino === undefined || (!pin.digital && pin.adc === undefined) || seen.has(pin.arduino)) continue;
    seen.add(pin.arduino);
    lines.push(`pinMode(${pin.arduino}, INPUT); digitalWrite(${pin.arduino}, LOW);`);
  }
  return lines.join("\n  ");
}

function makeReadOnly(plan: SelfTestPlan, profile: BoardProfile): string {
  const lines: string[] = [
    "vbEmitBegin(PSTR(\"pins.readonly\"));",
    "bool vbReadonlyStuck = false;",
  ];
  const passivePins = [...new Set(plan.subjects.map((subject) => subject.pin))];
  for (const pinName of passivePins) {
    const id = pinIdentifier(pinName);
    lines.push(`uint32_t vbPassive0_${id} = 0; uint32_t vbPassive1_${id} = 0;`);
  }
  for (const subject of plan.subjects) {
    const id = pinIdentifier(subject.pin);
    lines.push(`{ vbInput_${id}(0); vbPassive0_${id} = 0; for (uint32_t i = 0; i < VB_SAMPLES; ++i) vbPassive0_${id} += vbRead_${id}(); vbEmitRead(PSTR("${cppString(subject.pin)}"), 0, vbPassive0_${id}, VB_SAMPLES); }`);
    lines.push(`{ vbInput_${id}(1); vbPassive1_${id} = 0; for (uint32_t i = 0; i < VB_SAMPLES; ++i) vbPassive1_${id} += vbRead_${id}(); vbEmitRead(PSTR("${cppString(subject.pin)}"), 1, vbPassive1_${id}, VB_SAMPLES); }`);
  }
  const outputPins = new Map<string, { pin: BoardPin; active: number; passiveGuard: 0 | 1 }>();
  for (const subject of plan.subjects) {
    if (subject.kind !== "led" && subject.kind !== "buzzer") continue;
    const pin = subjectPin(subject, profile);
    const active = subject.kind === "led" ? (subject.activeHigh ? 1 : 0) : 1;
    outputPins.set(subject.pin, { pin, active, passiveGuard: active === 1 ? 1 : 0 });
  }
  for (const [pinName, data] of outputPins) {
    const id = pinIdentifier(pinName);
    if (data.pin.port === undefined || data.pin.bit === undefined) continue;
    lines.push(`if (!vbStuck_${id}) { if (${data.passiveGuard} == 1 && vbPassive0_${id} == VB_SAMPLES) { vbStuck_${id} = true; vbReadonlyStuck = true; vbEmitStuck(PSTR("${cppString(pinName)}"), 1); } else if (${data.passiveGuard} == 0 && vbPassive1_${id} == 0) { vbStuck_${id} = true; vbReadonlyStuck = true; vbEmitStuck(PSTR("${cppString(pinName)}"), 0); } else { uint8_t readback = vbProbe_${id}(${data.active}); vbEmitProbe(PSTR("${cppString(pinName)}"), ${data.active}, readback); if (readback != ${data.active}) { vbStuck_${id} = true; vbReadonlyStuck = true; vbEmitStuck(PSTR("${cppString(pinName)}"), readback); } } }`);
  }
  lines.push("vbReadonlyDone = true; vbEmitEnd(PSTR(\"pins.readonly\"), vbReadonlyStuck ? PSTR(\"fail\") : PSTR(\"pass\"), vbReadonlyStuck ? PSTR(\"stuck\") : nullptr);");
  return lines.join("\n  ");
}

function ensureReadonly(): string {
  return "if (!vbReadonlyDone) vbRunReadonly();";
}

function makeRails(): string {
  return [
    'vbEmitBegin(PSTR("rails.vcc"));',
    "uint8_t savedAdmux = ADMUX;",
    "ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);",
    "delay(2);",
    "ADCSRA |= _BV(ADSC);",
    "while (ADCSRA & _BV(ADSC)) { }",
    "uint16_t bandgap = ADC;",
    "uint16_t mv = bandgap == 0 ? 0 : (uint16_t)((1100UL * 1023UL) / bandgap);",
    "ADMUX = savedAdmux;",
    "vbEmitVcc(mv);",
    'vbEmitEnd(PSTR("rails.vcc"), mv >= 4000 && mv <= 6000 ? PSTR("pass") : PSTR("unknown"), nullptr);',
  ].join("\n  ");
}

function makeDigitalStuck(plan: SelfTestPlan): string {
  const checks = [...new Set(plan.subjects.map((subject) => `vbStuck_${pinIdentifier(subject.pin)}`))];
  return [
    'vbEmitBegin(PSTR("digital.stuck"));',
    `bool stuck = ${checks.length > 0 ? checks.join(" || ") : "false"};`,
    'vbEmitEnd(PSTR("digital.stuck"), stuck ? PSTR("fail") : PSTR("pass"), stuck ? PSTR("stuck") : nullptr);',
  ].join("\n  ");
}

function makeButton(plan: SelfTestPlan, profile: BoardProfile): string {
  const buttons = subjectByKind(plan, "button");
  if (buttons.length === 0) return 'vbEmitBegin(PSTR("button.interactive")); vbEmitEnd(PSTR("button.interactive"), PSTR("skipped"), PSTR("no button subjects"));';
  const lines: string[] = ['vbEmitBegin(PSTR("button.interactive"));', "bool buttonOk = true;"];
  buttons.forEach((subject, index) => {
    const id = pinIdentifier(subject.pin);
    const pull = subject.pull === "internal-up" ? 1 : 0;
    const choices = "\\\"done\\\"";
    lines.push(`if (vbStuck_${id}) { buttonOk = false; } else { vbInput_${id}(${pull}); const char* answerPress = vbAsk(PSTR("btn${index}-press"), PSTR("button.interactive"), PSTR("press-hold"), PSTR("${cppString(subject.part)}"), "${choices}", VB_PROMPT_TIMEOUT); uint32_t pressedOnes = 0; for (uint32_t i = 0; i < VB_SAMPLES; ++i) pressedOnes += vbRead_${id}(); vbEmitObsStable(PSTR("button.interactive"), PSTR("${cppString(subject.part)}"), PSTR("pressed"), pressedOnes, VB_SAMPLES); if (answerPress == nullptr || strcmp(answerPress, "timeout") == 0) buttonOk = false; const char* answerRelease = vbAsk(PSTR("btn${index}-release"), PSTR("button.interactive"), PSTR("release"), PSTR("${cppString(subject.part)}"), "${choices}", VB_PROMPT_TIMEOUT); uint32_t releasedOnes = 0; for (uint32_t i = 0; i < VB_SAMPLES; ++i) releasedOnes += vbRead_${id}(); vbEmitObsStable(PSTR("button.interactive"), PSTR("${cppString(subject.part)}"), PSTR("released"), releasedOnes, VB_SAMPLES); if (answerRelease == nullptr || strcmp(answerRelease, "timeout") == 0) buttonOk = false; }`);
  });
  lines.push('vbEmitEnd(PSTR("button.interactive"), buttonOk ? PSTR("pass") : PSTR("unknown"), buttonOk ? nullptr : PSTR("timeout or stuck"));');
  return lines.join("\n  ");
}

function makeAdcStats(subject: SelfTestSubject, profile: BoardProfile, phase: string): string {
  const pin = subjectPin(subject, profile);
  const read = `analogRead(${pin.arduino})`;
  return `{ uint16_t values[VB_SAMPLES]; for (uint32_t i = 0; i < VB_SAMPLES; ++i) values[i] = ${read}; for (uint32_t i = 1; i < VB_SAMPLES; ++i) { uint16_t key = values[i]; uint32_t j = i; while (j > 0 && values[j - 1] > key) { values[j] = values[j - 1]; --j; } values[j] = key; } uint32_t median = values[VB_SAMPLES / 2]; if ((VB_SAMPLES % 2UL) == 0) median = ((uint32_t)values[(VB_SAMPLES / 2) - 1] + values[VB_SAMPLES / 2]) / 2UL; vbEmitAdc(PSTR("${cppString(subject.pin)}"), PSTR("${cppString(phase)}"), median, values[0], values[VB_SAMPLES - 1], VB_SAMPLES); }`;
}

function makeLight(plan: SelfTestPlan, profile: BoardProfile): string {
  const lights = subjectByKind(plan, "light");
  if (lights.length === 0) return 'vbEmitBegin(PSTR("light.relative")); vbEmitEnd(PSTR("light.relative"), PSTR("skipped"), PSTR("no light subjects"));';
  const lines: string[] = ['vbEmitBegin(PSTR("light.relative"));', "bool lightOk = true;"];
  lights.forEach((subject, index) => {
    lines.push(makeAdcStats(subject, profile, "ambient"));
    lines.push(`const char* cover = vbAsk(PSTR("light${index}-cover"), PSTR("light.relative"), PSTR("cover"), PSTR("${cppString(subject.part)}"), "\\\"done\\\"", VB_PROMPT_TIMEOUT);`);
    lines.push(makeAdcStats(subject, profile, "covered"));
    lines.push(`const char* uncover = vbAsk(PSTR("light${index}-uncover"), PSTR("light.relative"), PSTR("uncover"), PSTR("${cppString(subject.part)}"), "\\\"done\\\"", VB_PROMPT_TIMEOUT); if (cover == nullptr || uncover == nullptr || strcmp(cover, "timeout") == 0 || strcmp(uncover, "timeout") == 0) lightOk = false;`);
  });
  lines.push('vbEmitEnd(PSTR("light.relative"), lightOk ? PSTR("pass") : PSTR("unknown"), lightOk ? nullptr : PSTR("timeout"));');
  return lines.join("\n  ");
}

function makePot(plan: SelfTestPlan, profile: BoardProfile): string {
  const pots = subjectByKind(plan, "pot");
  if (pots.length === 0) return 'vbEmitBegin(PSTR("pot.sweep")); vbEmitEnd(PSTR("pot.sweep"), PSTR("skipped"), PSTR("no potentiometer subjects"));';
  const lines: string[] = ['vbEmitBegin(PSTR("pot.sweep"));', "bool potOk = true;"];
  pots.forEach((subject, index) => {
    const minAnswer = `const char* potMin${index} = vbAsk(PSTR("pot${index}-min"), PSTR("pot.sweep"), PSTR("knob-min"), PSTR("${cppString(subject.part)}"), "\\\"done\\\"", VB_PROMPT_TIMEOUT);`;
    const maxAnswer = `const char* potMax${index} = vbAsk(PSTR("pot${index}-max"), PSTR("pot.sweep"), PSTR("knob-max"), PSTR("${cppString(subject.part)}"), "\\\"done\\\"", VB_PROMPT_TIMEOUT);`;
    lines.push(minAnswer, makeAdcStats(subject, profile, "min"), maxAnswer, makeAdcStats(subject, profile, "max"), `if (potMin${index} == nullptr || potMax${index} == nullptr || strcmp(potMin${index}, "timeout") == 0 || strcmp(potMax${index}, "timeout") == 0) potOk = false;`);
  });
  lines.push('vbEmitEnd(PSTR("pot.sweep"), potOk ? PSTR("pass") : PSTR("unknown"), potOk ? nullptr : PSTR("timeout"));');
  return lines.join("\n  ");
}

function makeLed(plan: SelfTestPlan, profile: BoardProfile): string {
  const leds = subjectByKind(plan, "led").sort((a, b) => a.order - b.order);
  if (leds.length === 0) return 'vbEmitBegin(PSTR("led.sequence")); vbEmitEnd(PSTR("led.sequence"), PSTR("skipped"), PSTR("no LED subjects"));';
  const lines: string[] = ['vbEmitBegin(PSTR("led.sequence"));', "bool ledOk = true;", "bool ledStuck = false;", "bool ledWrong = false;", "bool ledTimeout = false;"];
  const choices = [...leds.map((_subject, index) => `"${index + 1}"`), '"none"'].join(",");
  leds.forEach((subject) => {
    const id = pinIdentifier(subject.pin);
    const active = subject.activeHigh ? 1 : 0;
    const order = subject.order;
    lines.push(`if (vbStuck_${id}) { ledStuck = true; ledOk = false; } else { const char* which${order} = vbAskWhilePulsing(PSTR("led${order}"), PSTR("led.sequence"), PSTR("which-led"), PSTR("${cppString(subject.part)}"), "${choices.replace(/"/g, '\\"')}", VB_PROMPT_TIMEOUT, vbPulse_${id}, ${active}); if (which${order} == nullptr || strcmp(which${order}, "timeout") == 0) { ledTimeout = true; ledOk = false; } else if (strcmp(which${order}, "${order}") != 0) { ledWrong = true; ledOk = false; } if (which${order} != nullptr) vbEmitObsStr(PSTR("led.sequence"), PSTR("${cppString(subject.part)}"), PSTR("which"), which${order}); }`);
  });
  lines.push('vbEmitEnd(PSTR("led.sequence"), ledTimeout ? PSTR("unknown") : ((ledStuck || ledWrong) ? PSTR("fail") : PSTR("pass")), ledStuck ? PSTR("stuck") : (ledTimeout ? PSTR("timeout") : (ledWrong ? PSTR("wrong LED confirmation") : nullptr)));');
  return lines.join("\n  ");
}

function makeBuzzer(plan: SelfTestPlan, profile: BoardProfile): string {
  const buzzers = subjectByKind(plan, "buzzer");
  if (buzzers.length === 0) return 'vbEmitBegin(PSTR("buzzer.confirm")); vbEmitEnd(PSTR("buzzer.confirm"), PSTR("skipped"), PSTR("no buzzer subjects"));';
  const lines: string[] = ['vbEmitBegin(PSTR("buzzer.confirm"));', "bool buzzerOk = true;"];
  buzzers.forEach((subject, index) => {
    const id = pinIdentifier(subject.pin);
    const pin = subjectPin(subject, profile);
    const active = subject.active ? 1 : 0;
    lines.push(`if (vbStuck_${id}) { buzzerOk = false; } else { const char* heard${index} = vbAskWhileBuzzer(PSTR("buzzer${index}"), PSTR("buzzer.confirm"), PSTR("heard-beep"), PSTR("${cppString(subject.part)}"), "\\\"yes\\\",\\\"no\\\"", VB_PROMPT_TIMEOUT, ${pin.arduino}, ${active}, vbStuck_${id}); if (heard${index} == nullptr || strcmp(heard${index}, "timeout") == 0) buzzerOk = false; }`);
  });
  lines.push('vbEmitEnd(PSTR("buzzer.confirm"), buzzerOk ? PSTR("pass") : PSTR("unknown"), buzzerOk ? nullptr : PSTR("timeout or stuck"));');
  return lines.join("\n  ");
}

function makeTests(plan: SelfTestPlan, profile: BoardProfile): { functions: string; dispatch: string; all: string } {
  const functions = [
    `static void vbRunRails() {\n  ${makeRails()}\n}`,
    `static void vbRunReadonly() {\n  ${makeReadOnly(plan, profile)}\n}`,
    `static void vbRunDigitalStuck() {\n  ${ensureReadonly()}\n  ${makeDigitalStuck(plan)}\n}`,
    `static void vbRunButton() {\n  ${ensureReadonly()}\n  ${makeButton(plan, profile)}\n}`,
    `static void vbRunLight() {\n  ${ensureReadonly()}\n  ${makeLight(plan, profile)}\n}`,
    `static void vbRunPot() {\n  ${ensureReadonly()}\n  ${makePot(plan, profile)}\n}`,
    `static void vbRunLed() {\n  ${ensureReadonly()}\n  ${makeLed(plan, profile)}\n}`,
    `static void vbRunBuzzer() {\n  ${ensureReadonly()}\n  ${makeBuzzer(plan, profile)}\n}`,
    'static void vbRunContinuity() { vbEmitBegin(PSTR("net.continuity")); vbEmitEnd(PSTR("net.continuity"), PSTR("skipped"), PSTR("no resistor-guarded pin pairs")); }',
  ].join("\n\n");
  const dispatch = [
    `if (strcmp_P(test, PSTR("rails.vcc")) == 0) vbRunRails();`,
    `else if (strcmp_P(test, PSTR("pins.readonly")) == 0) vbRunReadonly();`,
    `else if (strcmp_P(test, PSTR("digital.stuck")) == 0) vbRunDigitalStuck();`,
    `else if (strcmp_P(test, PSTR("button.interactive")) == 0) vbRunButton();`,
    `else if (strcmp_P(test, PSTR("light.relative")) == 0) vbRunLight();`,
    `else if (strcmp_P(test, PSTR("pot.sweep")) == 0) vbRunPot();`,
    `else if (strcmp_P(test, PSTR("led.sequence")) == 0) vbRunLed();`,
    `else if (strcmp_P(test, PSTR("buzzer.confirm")) == 0) vbRunBuzzer();`,
    `else if (strcmp_P(test, PSTR("net.continuity")) == 0) vbRunContinuity();`,
    'else vbEmitErr(PSTR("unknown test"));',
  ].join("\n  ");
  const all = plan.tests.map((test) => {
    switch (test) {
      case "rails.vcc": return "vbRunRails();";
      case "pins.readonly": return "vbRunReadonly();";
      case "digital.stuck": return "vbRunDigitalStuck();";
      case "button.interactive": return "vbRunButton();";
      case "light.relative": return "vbRunLight();";
      case "pot.sweep": return "vbRunPot();";
      case "led.sequence": return "vbRunLed();";
      case "buzzer.confirm": return "vbRunBuzzer();";
      case "net.continuity": return "vbRunContinuity();";
    }
  }).join("\n  ");
  return { functions, dispatch, all };
}

export function renderBenchFirmware(plan: SelfTestPlan): string {
  const profile = validatePlan(plan);
  const pinHelpers = makePinHelpers(plan, profile);
  const tests = makeTests(plan, profile);
  const eta = new Eta({ autoEscape: false });
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  return eta.renderString(template, {
    design: cppString(plan.design),
    board: cppString(profile.id),
    safeIdle: makeSafeIdle(profile),
    pinHelpers,
    tests: tests.functions,
    dispatch: tests.dispatch,
    allTests: tests.all,
    samples: plan.timing.samples,
    ledOnMs: plan.timing.ledOnMs,
    ledPeriodMs: plan.timing.ledPeriodMs,
    ledPulses: plan.timing.ledPulses,
    promptTimeoutMs: plan.timing.promptTimeoutMs,
  });
}

export function compileBenchFirmware(plan: SelfTestPlan): Promise<CompileResult> {
  const source = renderBenchFirmware(plan);
  return compileSketch({ source, board: plan.board });
}

export function uploadCommand(input: { hexPath: string; port: string; board: BoardProfileId }): { command: string; args: string[] } {
  const profile = BOARD_PROFILES[input.board];
  if (!profile) throw new Error(`Unknown board profile: ${String(input.board)}`);
  if (!input.hexPath || !input.port) throw new Error("hexPath and port are required");
  const toolchain = defaultToolchain();
  return {
    command: toolchain.cli,
    args: ["--config-file", toolchain.config, "upload", "--fqbn", profile.fqbn, "--port", input.port, "--input-file", input.hexPath],
  };
}
