/// <reference lib="webworker" />

import type { Circuit } from "@vibread/core";
import { SimSession } from "@vibread/sim/browser";
import type { VirtualFault } from "./virtual.js";

interface InitMessage {
  type: "init";
  circuit: Circuit;
  hex: string;
  fault: VirtualFault;
}

interface SerialMessage {
  type: "serial";
  text: string;
}

interface CloseMessage {
  type: "close";
}

type WorkerInput = InitMessage | SerialMessage | CloseMessage;

let session: SimSession | undefined;
let unsubscribe: (() => void) | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let activeCircuit: Circuit | undefined;

function telemetry(): void {
  if (!session || !activeCircuit) return;
  const parts: Record<string, number> = {};
  for (const part of activeCircuit.parts) {
    try {
      parts[part.id] = session.partState(part.id);
    } catch {
      parts[part.id] = 0;
    }
  }
  self.postMessage({ type: "telemetry", timeMs: session.timeMs, parts });
}

function stop(): void {
  if (tick !== undefined) clearInterval(tick);
  tick = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  session = undefined;
  activeCircuit = undefined;
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const message = event.data;
  if (message.type === "close") {
    stop();
    return;
  }
  if (message.type === "serial") {
    if (!session) return;
    try {
      session.serialWrite(message.text);
      session.run(1);
      telemetry();
    } catch (error) {
      self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  stop();
  try {
    activeCircuit = message.circuit;
    session = new SimSession({ circuit: message.circuit, hex: message.hex });
    unsubscribe = session.onSerial((text) => self.postMessage({ type: "serial", text }));
    session.run(20);
    telemetry();
    tick = setInterval(() => {
      try {
        session?.run(20);
        telemetry();
      } catch (error) {
        self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }, 20);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
