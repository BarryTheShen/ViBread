import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { once } from "node:events";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { mountApi } from "./routes.js";
import { BUILD_VERSION, resolveBuildVersion } from "./version.js";

describe("build version", () => {
  it("falls back to the development version and current git short sha", () => {
    const expectedCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim().slice(0, 7);
    const version = resolveBuildVersion({ PATH: process.env.PATH });
    expect(version.version).toBe("0.1.0-dev");
    expect(version.commit).toBe(expectedCommit);
    expect(Number.isNaN(Date.parse(version.builtAt))).toBe(false);
  });

  it("uses build environment values when present", () => {
    expect(resolveBuildVersion({ APP_VERSION: "0.1.87", GITHUB_SHA: "abcdef0123456789", VIBREAD_BUILT_AT: "2026-09-27T03:10:00.000Z" })).toEqual({
      version: "0.1.87",
      commit: "abcdef0",
      builtAt: "2026-09-27T03:10:00.000Z",
    });
  });
});

describe("GET /api/version", () => {
  let server: Server | undefined;

  afterAll(async () => {
    const running = server;
    if (!running) return;
    await new Promise<void>((resolve, reject) => running.close((error) => (error ? reject(error) : resolve())));
  });

  it("returns build fields and the server runtime", async () => {
    const app = express();
    mountApi(app, {} as AppContext);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/api/version`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...BUILD_VERSION, runtime: "server" });
  });
});
