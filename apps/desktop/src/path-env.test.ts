import { describe, expect, it } from "vitest";
import { loginShellPath, serverPath } from "./path-env.js";

describe("serverPath", () => {
  it("keeps the user's PATH first, then system dirs, then per-user install dirs, without duplicates", () => {
    const path = serverPath("/home/ada/.nvm/versions/node/v22/bin:/usr/bin:/home/ada/.bun/bin", "/home/ada", "linux").split(":");
    expect(path.slice(0, 3)).toEqual(["/home/ada/.nvm/versions/node/v22/bin", "/usr/bin", "/home/ada/.bun/bin"]);
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/home/ada/.npm-global/bin");
    expect(path.at(-1)).toBe("/home/ada/.local/bin");
    expect(path.filter((dir) => dir === "/usr/bin" || dir === "/home/ada/.bun/bin")).toHaveLength(2);
  });

  it("still finds per-user installs when the GUI launch had no PATH at all", () => {
    expect(serverPath(undefined, "/Users/ada", "darwin").split(":")).toContain("/Users/ada/.bun/bin");
  });

  it("uses ; and backslashes on Windows and adds no POSIX system dirs", () => {
    const path = serverPath("C:\\Windows\\system32;C:\\Users\\ada\\AppData\\Roaming\\npm", "C:\\Users\\ada", "win32").split(";");
    expect(path[0]).toBe("C:\\Windows\\system32");
    expect(path).toContain("C:\\Users\\ada\\.bun\\bin");
    expect(path).not.toContain("/usr/bin");
  });
});

describe.runIf(process.platform !== "win32")("loginShellPath", () => {
  it("returns the PATH a login shell exports, ignoring shell banner output", async () => {
    const previous = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const path = await loginShellPath();
      expect(path).toBeTruthy();
      expect(path).not.toContain("__VIBREAD_PATH__");
      expect(path?.split(":")).toContain("/usr/bin");
    } finally {
      process.env.SHELL = previous;
    }
  });
});
