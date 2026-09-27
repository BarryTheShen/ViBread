import type { DeviceLine, Circuit } from "@vibread/core";
import type { FaultId } from "@vibread/bench";
import type { BenchTransport } from "./runner.js";
import { reloadForStaleChunk } from "../staleChunks.js";

export type VirtualFault = "none" | FaultId;

export interface VirtualPartTelemetry {
  timeMs: number;
  parts: Record<string, number>;
}

/**
 * The virtual board's latest part readings, for the board drawings that show them. The simulator reports every
 * 20 ms whether or not anything changed, and a blinking light changes the readings on nearly every report; redrawing
 * the breadboard is a full SVG parse. Readers are told at most once per animation frame, and only if some part's value
 * changed, so a steady board costs no redraws and a blinking one never outruns the screen (or the page's main thread).
 */
export interface TelemetryStore {
  get(): VirtualPartTelemetry | undefined;
  set(next: VirtualPartTelemetry | undefined): void;
  subscribe(listener: () => void): () => void;
}

function sameParts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function createTelemetryStore(schedule: (notify: () => void) => void = (notify) => void requestAnimationFrame(notify)): TelemetryStore {
  let current: VirtualPartTelemetry | undefined;
  // What readers see: changes only when they are told, so a render between frames never sees a different reading.
  let published: VirtualPartTelemetry | undefined;
  let pending = false;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    pending = false;
    published = current;
    for (const listener of listeners) listener();
  };
  return {
    get: () => published,
    set(next) {
      if (next === current || (next && current && sameParts(next.parts, current.parts))) return;
      current = next;
      if (pending) return;
      pending = true;
      schedule(notify);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface VirtualBenchOptions {
  circuit: Circuit;
  hex: string;
  fault: VirtualFault;
  onTelemetry?: (telemetry: VirtualPartTelemetry) => void;
  onError?: (message: string) => void;
}

const HAND_ACTIONS = ["press-hold", "release", "cover", "uncover", "knob-min", "knob-max"] as const;
type HandAction = (typeof HAND_ACTIONS)[number];

export class VirtualBenchTransport implements BenchTransport {
  private readonly listeners = new Set<(data: Uint8Array) => void>();
  private readonly encoder = new TextEncoder();
  private serialBuffer = "";
  private worker: Worker | undefined;
  private readonly onTelemetry?: (telemetry: VirtualPartTelemetry) => void;
  private readonly onError?: (message: string) => void;

  constructor(options: { onTelemetry?: (telemetry: VirtualPartTelemetry) => void; onError?: (message: string) => void } = {}) {
    this.onTelemetry = options.onTelemetry;
    this.onError = options.onError;
  }

  start(options: VirtualBenchOptions): void {
    this.worker?.terminate();
    this.serialBuffer = "";
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module", name: "vibread-bench-sim" });
    this.worker.onmessage = (event: MessageEvent<VirtualWorkerMessage>) => {
      const message = event.data;
      if (message.type === "serial") {
        this.forwardVirtualHand(message.text);
        const bytes = this.encoder.encode(message.text);
        for (const listener of this.listeners) listener(bytes);
      } else if (message.type === "telemetry") {
        this.onTelemetry?.({ timeMs: message.timeMs, parts: message.parts });
      } else if (message.type === "error") {
        this.onError?.(message.message);
      }
    };
    this.worker.onerror = (event) => {
      // A plain Event (no message) is a worker that never loaded: after a redeploy the old file name is gone (issue #29).
      // Reload once for the new build; otherwise say so instead of a bare "stopped".
      if (!(event instanceof ErrorEvent)) {
        this.onError?.(reloadForStaleChunk() ? "ViBread was updated; reloading the page…" : "The virtual board's code couldn't load. Reload the page to try again.");
        return;
      }
      this.onError?.(event.message ? event.message.replace(/^Uncaught\s+/, "") : "The virtual board worker stopped.");
    };
    this.worker.postMessage({ type: "init", circuit: options.circuit, hex: options.hex, fault: options.fault });
  }

  private forwardVirtualHand(text: string): void {
    this.serialBuffer += text;
    const lines = this.serialBuffer.split(/\r?\n/);
    this.serialBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (raw.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof value !== "object" || value === null || !("t" in value) || value.t !== "ask") continue;
      const ask = value as Extract<DeviceLine, { t: "ask" }>;
      if (ask.part !== undefined && (HAND_ACTIONS as readonly string[]).includes(ask.kind)) {
        this.worker?.postMessage({ type: "action", kind: ask.kind as HandAction, part: ask.part });
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.worker) throw new Error("Connect the virtual board first.");
    this.worker.postMessage({ type: "serial", text: new TextDecoder().decode(data) });
  }

  on(_event: "data", handler: (data: Uint8Array) => void): void {
    this.listeners.add(handler);
  }

  off(_event: "data", handler: (data: Uint8Array) => void): void {
    this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.worker?.postMessage({ type: "close" });
    this.worker?.terminate();
    this.worker = undefined;
    this.serialBuffer = "";
    this.listeners.clear();
  }
}

interface VirtualWorkerMessageSerial {
  type: "serial";
  text: string;
}

interface VirtualWorkerMessageTelemetry {
  type: "telemetry";
  timeMs: number;
  parts: Record<string, number>;
}

interface VirtualWorkerMessageError {
  type: "error";
  message: string;
}

type VirtualWorkerMessage = VirtualWorkerMessageSerial | VirtualWorkerMessageTelemetry | VirtualWorkerMessageError;

export function faultLabel(fault: VirtualFault): string {
  if (fault === "none") return "No fault (golden wiring)";
  const labels: Record<FaultId, string> = {
    "button-leg-in-gnd-row": "Button leg in a GND row",
    "button-rotated-90": "Button rotated 90 degrees",
    "led-jumpers-swapped": "Two LED signal jumpers swapped",
    "led-reversed": "LED reversed",
    "led-missing": "LED missing",
    "divider-resistor-missing": "Photoresistor divider resistor missing",
    "output-jumper-in-rail-row": "Output jumper in a rail row",
    "wrong-resistor-value": "Wrong resistor value",
    "moved-lead": "Part lead moved one row",
    "missing-jumper": "Jumper missing",
  };
  return labels[fault];
}
