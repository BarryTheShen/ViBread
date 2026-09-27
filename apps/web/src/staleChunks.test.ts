import { describe, expect, it } from "vitest";
import { isStaleChunkError, mayAutoReload, STALE_CHUNK_GUARD_MS } from "./staleChunks.js";

describe("stale chunk reload", () => {
  it("recognises each browser's failed lazy import, and nothing else", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: http://x/assets/MissionPage-abc.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module: http://x/a.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleChunkError({ status: 404 })).toBe(false);
  });

  it("reloads once, then refuses until the guard window has passed", () => {
    const now = 1_000_000;
    expect(mayAutoReload(null, now)).toBe(true);
    expect(mayAutoReload(String(now - 5_000), now)).toBe(false);
    expect(mayAutoReload(String(now - STALE_CHUNK_GUARD_MS), now)).toBe(true);
    expect(mayAutoReload("garbage", now)).toBe(true);
  });
});
