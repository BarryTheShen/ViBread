/**
 * Schematic worker (child process of packages/assembly/src/schematic): JSON lines in, SVG out.
 * Every drawing is checked against its circuit; a drawing that fails is replaced by the connection table.
 */
import { createInterface } from "node:readline";
import type { Circuit } from "@vibread/core";
import { connectionTableSvg, verifiedSchematic } from "../src/schematic/fallback.js";
import { drawSchematic } from "./draw.js";

type WorkerRequest = { id: string; circuit: Circuit };
type WorkerResponse = { id: string; svg?: string; error?: string };

async function renderSchematic(circuit: Circuit): Promise<string> {
  let drawing: string;
  try {
    drawing = await drawSchematic(circuit);
  } catch (error) {
    const reason = `SCH-LAYOUT: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`schematic: "${circuit.title}" falls back to the connection table: ${reason}\n`);
    return connectionTableSvg(circuit, [reason]);
  }
  const { svg, issues } = verifiedSchematic(circuit, drawing);
  if (issues.length > 0) {
    process.stderr.write(`schematic: "${circuit.title}" falls back to the connection table:\n  ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n  ")}\n`);
  }
  return svg;
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; circuit?: unknown };
  return typeof candidate.id === "string" && typeof candidate.circuit === "object" && candidate.circuit !== null;
}

function writeResponse(response: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let requestId = "unknown";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isWorkerRequest(parsed)) throw new Error("invalid schematic worker request");
    requestId = parsed.id;
    writeResponse({ id: requestId, svg: await renderSchematic(parsed.circuit) });
  } catch (error) {
    writeResponse({ id: requestId, error: error instanceof Error ? error.message : String(error) });
  }
}
