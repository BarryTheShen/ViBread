import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installToolchain, toolchainPaths } from "../../../scripts/setup-toolchain.mjs";
import type { DesktopPaths } from "./runtime.js";
import { pendingSteps, runSetup, STEP_VERSIONS } from "./setup.js";

vi.mock("electron", () => ({ app: {} }));
vi.mock("../../../scripts/setup-toolchain.mjs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installToolchain: vi.fn(),
}));
// setup.log opens asynchronously; keep it off disk so afterEach can remove the directory.
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openLog: () => ({ write: () => true, end: () => {} }),
}));

describe("pendingSteps", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const userData = (): DesktopPaths => {
    root = mkdtempSync(join(tmpdir(), "vb-desktop-setup-"));
    const dir = join(root, "ViBread");
    return { runtime: "", node: "", userData: dir, data: join(dir, "data"), toolchain: join(dir, "toolchain"), logs: join(dir, "logs") };
  };
  const recordDone = (paths: DesktopPaths) => {
    mkdirSync(paths.userData, { recursive: true });
    const steps = Object.fromEntries(Object.entries(STEP_VERSIONS).map(([step, version]) => [step, { version, at: "2026-09-27T00:00:00.000Z", ms: 1 }]));
    writeFileSync(join(paths.userData, "setup.json"), JSON.stringify({ steps }));
  };

  it("runs every step on a fresh install", () => {
    expect(pendingSteps(userData())).toEqual(["toolchain", "seed"]);
  });

  it("runs nothing once both steps are recorded and arduino-cli is installed", () => {
    const paths = userData();
    recordDone(paths);
    const cli = toolchainPaths(paths.toolchain).cli;
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    expect(pendingSteps(paths)).toEqual([]);
  });

  it("reinstalls the toolchain when arduino-cli was deleted after setup", () => {
    const paths = userData();
    recordDone(paths);
    expect(pendingSteps(paths)).toEqual(["toolchain"]);
  });

  it("redoes the toolchain next launch when a rerun is interrupted after arduino-cli was re-extracted", async () => {
    const paths = userData();
    recordDone(paths);
    const cli = toolchainPaths(paths.toolchain).cli;
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    // The rerun gets as far as extracting bin/arduino-cli, then the app quits before arduino:avr / ArduinoJson.
    vi.mocked(installToolchain).mockRejectedValueOnce(new Error("aborted"));
    await expect(runSetup(paths, ["toolchain"], () => {})).rejects.toThrow("aborted");
    expect(pendingSteps(paths)).toEqual(["toolchain"]);
    // The seed record is untouched by the toolchain rerun.
    expect(JSON.parse(readFileSync(join(paths.userData, "setup.json"), "utf8")).steps.seed.version).toBe(STEP_VERSIONS.seed);
  });

  it("records a step only once it finishes", async () => {
    const paths = userData();
    const installed = toolchainPaths(paths.toolchain);
    vi.mocked(installToolchain).mockImplementationOnce(async () => {
      expect(pendingSteps(paths)).toContain("toolchain");
      mkdirSync(dirname(installed.cli), { recursive: true });
      writeFileSync(installed.cli, "");
      return installed;
    });
    await runSetup(paths, ["toolchain"], () => {});
    expect(pendingSteps(paths)).toEqual(["seed"]);
  });
});
