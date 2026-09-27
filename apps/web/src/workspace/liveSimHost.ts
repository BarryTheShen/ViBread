import type { Circuit } from "@vibread/core";
import { SimSession } from "@vibread/sim/browser";
import { buzzerTones } from "./buzzerAudio.js";
import type { LiveSimInput, LiveSimOutput } from "./liveSimProtocol.js";

/**
 * "Try it" simulator: runs the revision's app.hex in SimSession at wall-clock speed (virtual time follows real
 * elapsed time, capped per tick so a background-throttled tab doesn't fast-forward) and streams part states.
 * liveSim.worker.ts wires this to the worker's `self`; tests drive it with a manual clock.
 */
export const TICK_MS = 20;
const MAX_STEP_MS = 100;

export interface LiveSimClock {
  now(): number;
  /** Calls `tick` every `ms`; returns a function that stops it. */
  every(ms: number, tick: () => void): () => void;
}

export interface LiveSimHost {
  handle(message: LiveSimInput): void;
  /** Stops the board and tells the page why (an error thrown outside a message, e.g. an uncaught one). */
  fail(error: unknown): void;
}

export function createLiveSimHost(post: (message: LiveSimOutput) => void, clock: LiveSimClock): LiveSimHost {
  let session: SimSession | undefined;
  let circuit: Circuit | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancelTick: (() => void) | undefined;
  let lastWall = 0;

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
    post({ type: "state", timeMs: session.timeMs, parts, tones: buzzerTones(circuit.parts, session) });
  }

  function stop(): void {
    cancelTick?.();
    cancelTick = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    session = undefined;
  }

  function fail(error: unknown): void {
    stop();
    if (error instanceof Error) post({ type: "error", message: error.message || error.name, ...(error.stack ? { stack: error.stack } : {}) });
    else post({ type: "error", message: String(error) });
  }

  function guarded(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      fail(error);
    }
  }

  function handle(message: LiveSimInput): void {
    switch (message.type) {
      case "start":
        stop();
        guarded(() => {
          circuit = message.circuit;
          session = new SimSession({ circuit: message.circuit, hex: message.hex, light: message.light, analog: message.analog });
          unsubscribe = session.onSerial((text) => post({ type: "serial", text }));
          lastWall = clock.now();
          cancelTick = clock.every(TICK_MS, () => {
            guarded(() => {
              const now = clock.now();
              const step = Math.min(MAX_STEP_MS, Math.max(1, now - lastWall));
              lastWall = now;
              session?.run(step);
              snapshot();
            });
          });
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
  }

  return { handle, fail };
}
