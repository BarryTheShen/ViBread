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

interface ActionMessage {
  type: "action";
  kind: "press-hold" | "release" | "cover" | "uncover" | "knob-min" | "knob-max";
  part: string;
}

interface CloseMessage {
  type: "close";
}

type WorkerInput = InitMessage | SerialMessage | CloseMessage | ActionMessage;

let session: SimSession | undefined;
let unsubscribe: (() => void) | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let activeCircuit: Circuit | undefined;
let actionBuffer = "";

function applyVirtualAction(kind: ActionMessage["kind"], part: string): void {
  if (!session) return;
  if (kind === "press-hold") session.setDigital(part, true);
  else if (kind === "release") session.setDigital(part, false);
  else if (kind === "cover") session.setLight(part, 0.05);
  else if (kind === "uncover") session.setLight(part, 0.8);
  else if (kind === "knob-min") session.setAnalog(part, 0);
  else if (kind === "knob-max") session.setAnalog(part, 1);
}

function applyVirtualActions(text: string): void {
  if (!session) return;
  actionBuffer += text;
  const lines = actionBuffer.split(/\r?\n/);
  actionBuffer = lines.pop() ?? "";
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const line = value as Record<string, unknown>;
    if (line.t !== "ask" || typeof line.kind !== "string" || typeof line.part !== "string") continue;
    if ((["press-hold", "release", "cover", "uncover", "knob-min", "knob-max"] as readonly string[]).includes(line.kind)) {
      applyVirtualAction(line.kind as ActionMessage["kind"], line.part);
    }
  }
}

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
  if (message.type === "action") {
    applyVirtualAction(message.kind, message.part);
    telemetry();
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
    unsubscribe = session.onSerial((text) => {
      applyVirtualActions(text);
      self.postMessage({ type: "serial", text });
    });
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
