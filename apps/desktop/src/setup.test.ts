import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolchainPaths } from "../../../scripts/setup-toolchain.mjs";
import type { DesktopPaths } from "./runtime.js";
import { pendingSteps, STEP_VERSIONS } from "./setup.js";

vi.mock("electron", () => ({ app: {} }));

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
});
