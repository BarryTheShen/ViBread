import type { Circuit } from "@vibread/core";
import type { BenchTransport } from "./runner.js";

export type VirtualFault = "none" | "button-gnd" | "led-jumpers" | "divider-resistor";

export interface VirtualPartTelemetry {
  timeMs: number;
  parts: Record<string, number>;
}

export interface VirtualBenchOptions {
  circuit: Circuit;
  hex: string;
  fault: VirtualFault;
  onTelemetry?: (telemetry: VirtualPartTelemetry) => void;
  onError?: (message: string) => void;
}

export class VirtualBenchTransport implements BenchTransport {
  private readonly listeners = new Set<(data: Uint8Array) => void>();
  private readonly encoder = new TextEncoder();
  private worker: Worker | undefined;
  private readonly onTelemetry?: (telemetry: VirtualPartTelemetry) => void;
  private readonly onError?: (message: string) => void;

  constructor(options: { onTelemetry?: (telemetry: VirtualPartTelemetry) => void; onError?: (message: string) => void } = {}) {
    this.onTelemetry = options.onTelemetry;
    this.onError = options.onError;
  }

  start(options: VirtualBenchOptions): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module", name: "vibread-bench-sim" });
    this.worker.onmessage = (event: MessageEvent<VirtualWorkerMessage>) => {
      const message = event.data;
      if (message.type === "serial") {
        const bytes = this.encoder.encode(message.text);
        for (const listener of this.listeners) listener(bytes);
      } else if (message.type === "telemetry") {
        this.onTelemetry?.({ timeMs: message.timeMs, parts: message.parts });
      } else if (message.type === "error") {
        this.onError?.(message.message);
      }
    };
    this.worker.onerror = (event) => this.onError?.(event.message || "The virtual board worker stopped.");
    this.worker.postMessage({ type: "init", circuit: options.circuit, hex: options.hex, fault: options.fault });
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
    this.listeners.clear();
  }
}

interface VirtualWorkerInit {
  type: "init";
  circuit: Circuit;
  hex: string;
  fault: VirtualFault;
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
  const labels: Record<VirtualFault, string> = {
    none: "No fault (golden wiring)",
    "button-gnd": "Button leg in the GND row",
    "led-jumpers": "Two LED jumpers swapped",
    "divider-resistor": "Photoresistor divider resistor missing",
  };
  return labels[fault];
}
