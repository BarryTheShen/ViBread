import type { TraceFrame } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { frameIndexAt } from "./replay.js";

const frames: TraceFrame[] = [0, 20, 40, 100].map((t) => ({ t, parts: { LED1: t / 100 }, pins: {} }));

describe("frameIndexAt", () => {
  it("returns the last frame at or before t", () => {
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 19.9)).toBe(0);
    expect(frameIndexAt(frames, 20)).toBe(1);
    expect(frameIndexAt(frames, 99)).toBe(2);
    expect(frameIndexAt(frames, 100)).toBe(3);
  });

  it("clamps before the first frame, after the last, and on empty traces", () => {
    expect(frameIndexAt(frames, -5)).toBe(0);
    expect(frameIndexAt(frames, 10_000)).toBe(3);
    expect(frameIndexAt([], 50)).toBe(0);
  });
});
