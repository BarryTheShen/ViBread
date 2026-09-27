import { describe, expect, it } from "vitest";
import { benchRuntime } from "./benchLog.js";

describe("bench runtime in the Diagnostics log", () => {
  it("tells the desktop app (Electron on Windows) from Chrome in a browser", () => {
    const desktop = benchRuntime({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) vibread/0.1.0 Chrome/138.0.7204.100 Electron/37.2.0 Safari/537.36",
      platform: "Win32",
      userAgentData: { platform: "Windows" },
    });
    expect(desktop).toMatchObject({ app: "desktop", os: "Windows", electron: "37.2.0", chrome: "138.0.7204.100" });

    const browser = benchRuntime({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "MacIntel" });
    expect(browser).toMatchObject({ app: "browser", os: "MacIntel", chrome: "140.0.0.0" });
    expect(browser).not.toHaveProperty("electron");
  });
});
