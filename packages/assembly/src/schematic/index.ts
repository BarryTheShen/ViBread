import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  type Circuit,
  MODULES,
} from "@vibread/core";

type WorkerResponse = { id: string; svg?: string; error?: string };
type Pending = { resolve: (svg: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

let child: ChildProcessWithoutNullStreams | undefined;
let outputBuffer = "";
let requestNumber = 0;
const pending = new Map<string, Pending>();
let exitHookInstalled = false;

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function runtimePath(): string {
  return fileURLToPath(new URL("../../schematic-runtime/render.ts", import.meta.url));
}

function loaderPath(): string {
  const resolved = import.meta.resolve("tsx/esm");
  return fileURLToPath(resolved);
}

function decodeResponse(value: unknown): WorkerResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { id?: unknown; svg?: unknown; error?: unknown };
  if (typeof candidate.id !== "string") return undefined;
  if (typeof candidate.svg === "string") return { id: candidate.id, svg: candidate.svg };
  if (typeof candidate.error === "string") return { id: candidate.id, error: candidate.error };
  return undefined;
}

function rejectPending(error: Error): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(error);
    pending.delete(id);
  }
}

function attachOutput(processChild: ChildProcessWithoutNullStreams): void {
  processChild.stdout.setEncoding("utf8");
  processChild.stdout.on("data", (chunk: string) => {
    outputBuffer += chunk;
    let newline = outputBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = outputBuffer.slice(0, newline).trim();
      outputBuffer = outputBuffer.slice(newline + 1);
      newline = outputBuffer.indexOf("\n");
      if (!line) continue;
      try {
        const response = decodeResponse(JSON.parse(line) as unknown);
        if (!response) continue;
        const request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.svg !== undefined) request.resolve(response.svg);
        else request.reject(new Error(response.error ?? "schematic worker failed"));
      } catch {
        // Keep the protocol stream alive if a child-side diagnostic is malformed.
      }
    }
  });
}

function startWorker(): ChildProcessWithoutNullStreams {
  const processChild = spawn(process.execPath, ["--import", loaderPath(), runtimePath()], {
    cwd: fileURLToPath(new URL("../../schematic-runtime/", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachOutput(processChild);
  processChild.stderr.setEncoding("utf8");
  processChild.stderr.on("data", () => {
    // Diagnostics stay off the JSON-lines protocol; the parent reports request errors.
  });
  processChild.once("error", (error) => {
    if (child === processChild) child = undefined;
    rejectPending(errorFrom(error));
  });
  processChild.once("exit", (code, signal) => {
    if (child === processChild) child = undefined;
    rejectPending(new Error(`schematic worker exited (${code ?? "signal"} ${signal ?? ""})`));
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      child?.kill();
    });
  }
  return processChild;
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (!child || child.killed || child.exitCode !== null) child = startWorker();
  return child;
}

function sendRender(circuit: Circuit): Promise<string> {
  const processChild = ensureWorker();
  const id = `schematic-${requestNumber++}`;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      processChild.kill();
      reject(new Error("schematic render timed out after 20 seconds"));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    try {
      processChild.stdin.write(`${JSON.stringify({ id, circuit })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(errorFrom(error));
    }
  });
}

/** Render ViBread IR in the isolated zod-3 tscircuit child process. */
export async function renderSchematicSvg(circuit: Circuit): Promise<string> {
  return sendRender(circuit);
}

/** Return a plain-language netlist table for the Schematic tab fallback. */
export function schematicSummary(circuit: Circuit): string {
  const rows = circuit.nets.map((net) => {
    const connections = net.pins
      .map((pin) => {
        if (pin.part === "board") return `Arduino ${pin.pin}`;
        const part = circuit.parts.find((candidate) => candidate.id === pin.part);
        const label = part?.label ?? MODULES[part?.module ?? "generic"].name;
        return `${pin.part} (${label}) · pin ${pin.pin}`;
      })
      .join(" · ");
    return `| ${net.id} | ${net.kind} | ${connections} |`;
  });
  return [
    `## ${circuit.title}`,
    "",
    circuit.summary,
    "",
    "| Net | Kind | Connected pins |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}
