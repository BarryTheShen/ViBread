import { describe, expect, it } from "vitest";
import { createTelemetryStore } from "./virtual.js";

/**
 * The simulator reports part readings every 20 ms, and a blinking light changes them on nearly every report. When each
 * report re-rendered the bench page, React warned "Maximum update depth exceeded" at the "which light blinked?" prompt;
 * redrawing the board on each report froze the page. Readers hear about a change at most once per frame.
 */
describe("virtual board telemetry", () => {
  function setup() {
    const frames: Array<() => void> = [];
    const store = createTelemetryStore((notify) => frames.push(notify));
    let notified = 0;
    store.subscribe(() => (notified += 1));
    const frame = () => frames.splice(0, frames.length).forEach((notify) => notify());
    return { store, frame, notified: () => notified };
  }

  it("tells readers once per frame however many reports changed, and not at all for a steady board", () => {
    const { store, frame, notified } = setup();
    // A light blinking: a dozen different readings between two frames.
    for (let tick = 0; tick < 12; tick += 1) store.set({ timeMs: tick * 20, parts: { LED1: tick % 2 ? 0.9 : 0.1, BTN1: 1 } });
    expect(notified()).toBe(0);
    frame();
    expect(notified()).toBe(1);
    expect(store.get()?.parts).toEqual({ LED1: 0.9, BTN1: 1 });

    // A second of the same readings: nothing to redraw.
    for (let tick = 12; tick < 62; tick += 1) store.set({ timeMs: tick * 20, parts: { LED1: 0.9, BTN1: 1 } });
    frame();
    expect(notified()).toBe(1);
  });

  it("counts a part appearing or the board being cleared as a change", () => {
    const { store, frame, notified } = setup();
    store.set({ timeMs: 0, parts: { LED1: 1 } });
    frame();
    store.set({ timeMs: 20, parts: { LED1: 1, LDR1: 0.5 } });
    frame();
    store.set(undefined);
    frame();
    store.set(undefined);
    frame();
    expect(notified()).toBe(3);
    expect(store.get()).toBeUndefined();
  });
});
