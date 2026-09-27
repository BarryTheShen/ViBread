import { describe, expect, it, vi } from "vitest";
import { descendantsOf } from "./runtime.js";

vi.mock("electron", () => ({ app: {} }));

describe("descendantsOf", () => {
  it("finds the whole tree below the server (arduino-cli → avrdude, workers), nearest first", () => {
    const table = [
      { pid: 100, parent: 4, started: 1_000 }, // server
      { pid: 200, parent: 100, started: 2_000 }, // arduino-cli upload
      { pid: 300, parent: 200, started: 2_100 }, // avrdude
      { pid: 210, parent: 100, started: 1_500 }, // schematic worker
      { pid: 999, parent: 4, started: 500 }, // unrelated
    ];
    expect(descendantsOf(100, table)).toEqual([200, 210, 300]);
  });

  it("skips processes whose recorded parent pid is an older, reused pid", () => {
    // pid 100 once belonged to a process that died; 150 still names it as parent but started before the server did.
    const table = [
      { pid: 100, parent: 4, started: 5_000 },
      { pid: 150, parent: 100, started: 1_000 },
      { pid: 160, parent: 150, started: 1_200 },
      { pid: 200, parent: 100, started: 6_000 },
    ];
    expect(descendantsOf(100, table)).toEqual([200]);
  });

  it("returns nothing for a pid without children and survives parent-pid cycles", () => {
    expect(descendantsOf(7, [{ pid: 8, parent: 9, started: 0 }])).toEqual([]);
    expect(descendantsOf(1, [{ pid: 2, parent: 1, started: 0 }, { pid: 1, parent: 2, started: 0 }])).toEqual([2]);
  });
});
