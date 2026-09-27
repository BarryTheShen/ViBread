import { describe, expect, it, vi } from "vitest";
import { asciiWorkRoot, descendantsOf } from "./runtime.js";

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

describe("asciiWorkRoot", () => {
  const env = { ProgramData: "C:\\ProgramData" };
  const plainTemp = "C:\\Users\\barry\\AppData\\Local\\Temp";

  it("keeps an ASCII Windows profile's folders where they are, spaces included", () => {
    expect(asciiWorkRoot("C:\\Users\\Barry Shen\\AppData\\Roaming\\ViBread", "C:\\Users\\BARRYS~1\\AppData\\Local\\Temp", env, "win32")).toBeUndefined();
  });

  it("moves a non-ASCII Windows profile's compiler work under ProgramData, one stable folder per profile", () => {
    const chinese = asciiWorkRoot("C:\\Users\\沈巴瑞\\AppData\\Roaming\\ViBread", "C:\\Users\\沈巴瑞\\AppData\\Local\\Temp", env, "win32");
    const accented = asciiWorkRoot("C:\\Users\\Bärry\\AppData\\Roaming\\ViBread", plainTemp, env, "win32");
    expect(chinese).toMatch(/^C:\\ProgramData\\ViBread\\[0-9a-f]{12}$/);
    expect(accented).toMatch(/^C:\\ProgramData\\ViBread\\[0-9a-f]{12}$/);
    expect(accented).not.toBe(chinese);
    expect(asciiWorkRoot("c:\\users\\沈巴瑞\\appdata\\roaming\\vibread", plainTemp, env, "win32")).toBe(chinese);
    // An ASCII data folder with a non-ASCII temp folder still compiles in the temp folder, so it moves too.
    expect(asciiWorkRoot("D:\\ViBread", "C:\\Users\\Zoë\\AppData\\Local\\Temp", env, "win32")).toMatch(/^C:\\ProgramData\\ViBread\\/);
  });

  it("does nothing outside Windows, or when ProgramData itself isn't ASCII", () => {
    expect(asciiWorkRoot("/home/沈巴瑞/.config/ViBread", "/tmp", env, "linux")).toBeUndefined();
    expect(asciiWorkRoot("C:\\Users\\沈巴瑞\\AppData\\Roaming\\ViBread", plainTemp, { ProgramData: "C:\\数据" }, "win32")).toBeUndefined();
  });
});
