/// <reference lib="webworker" />

import type { Circuit } from "@vibread/core";
import { SimSession } from "@vibread/sim/browser";
import type { LiveSimInput, LiveSimOutput } from "./liveSimProtocol.js";

/**
 * "Try it" simulator: runs the revision's app.hex in SimSession at wall-clock speed (virtual time follows real
 * elapsed time, capped per tick so a background-throttled tab doesn't fast-forward) and streams part states.
 */
const TICK_MS = 20;
const MAX_STEP_MS = 100;

let session: SimSession | undefined;
let circuit: Circuit | undefined;
let unsubscribe: (() => void) | undefined;
let timer: number | undefined;
let lastWall = 0;

const post = (message: LiveSimOutput) => self.postMessage(message);

function snapshot(): void {
  if (!session || !circuit) return;
  const parts: Record<string, number> = {};
  for (const part of circuit.parts) {
    try {
      parts[part.id] = session.partState(part.id);
    } catch {
      parts[part.id] = 0;
    }
  }
  post({ type: "state", timeMs: session.timeMs, parts });
}

function stop(): void {
  clearInterval(timer);
  timer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  session = undefined;
}

function guarded(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    stop();
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

self.onmessage = (event: MessageEvent<LiveSimInput>) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      stop();
      guarded(() => {
        circuit = message.circuit;
        session = new SimSession({ circuit: message.circuit, hex: message.hex, light: message.light, analog: message.analog });
        unsubscribe = session.onSerial((text) => post({ type: "serial", text }));
        lastWall = performance.now();
        timer = self.setInterval(() => {
          guarded(() => {
            const now = performance.now();
            const step = Math.min(MAX_STEP_MS, Math.max(1, now - lastWall));
            lastWall = now;
            session?.run(step);
            snapshot();
          });
        }, TICK_MS);
        post({ type: "started" });
      });
      return;
    case "digital":
      guarded(() => session?.setDigital(message.part, message.value));
      return;
    case "light":
      guarded(() => session?.setLight(message.part, message.level));
      return;
    case "analog":
      guarded(() => session?.setAnalog(message.part, message.value));
      return;
    case "serial":
      guarded(() => session?.serialWrite(message.text));
      return;
    case "stop":
      stop();
      return;
  }
};
