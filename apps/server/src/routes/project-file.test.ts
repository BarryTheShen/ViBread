import express from "express";
import type { Server } from "node:http";
import type { AppContext } from "../context.js";
import { testDeps } from "../agents/testing.js";
import { mountProjectFileRoutes } from "./project-file.js";
import type { ProjectFileDependencies } from "../services/project-file.js";
import { GOLDEN } from "@vibread/fixtures";
import type { RevisionResults } from "@vibread/core";
import { describe, expect, it } from "vitest";

const fixture = GOLDEN.find((golden) => golden.key === "moon-phase-lamp")!;

function pipeline(store: ProjectFileDependencies["store"]): ProjectFileDependencies["pipeline"] {
  return {
    async evaluate(missionId, n) {
      const revision = await store.getRevision(missionId, n);
      const result: RevisionResults = { reports: [], artifacts: {} };
      if (revision) await store.saveResults(missionId, n, result);
      return result;
    },
    async idle() {},
  };
}

async function server() {
  const deps = testDeps();
  const mission = await deps.store.createMission({ title: fixture.circuit.title, brief: fixture.brief, ownerId: "operator", inventory: fixture.inventory });
  await deps.store.createRevision(mission.id, { circuit: fixture.circuit, suite: fixture.suite, author: { kind: "system", id: "fixture", channel: "system" } });
  const app = express();
  const ctx = {
    ...deps,
    config: { ...deps.config, singleOperator: true },
    runtime: { pipeline: pipeline(deps.store) },
    operator: async () => ({ id: "operator", name: "Operator" }),
  } as unknown as AppContext;
  mountProjectFileRoutes(app, ctx);
  app.use((error: { status?: number; code?: string; message?: string }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? "INTERNAL_ERROR", message: error.message ?? "internal" } });
  });
  const listener = await new Promise<Server>((resolve) => resolve(app.listen(0)));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  return { deps, mission, base, close: () => listener.close() };
}

describe("project file routes", () => {
  it("exports an attachment and imports it through multipart into a new mission", async () => {
    const running = await server();
    try {
      const exported = await fetch(`${running.base}/api/missions/${running.mission.id}/project`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toContain("application/zip");
      expect(exported.headers.get("content-disposition")).toContain(".vibread");
      const form = new FormData();
      form.set("file", new Blob([await exported.arrayBuffer()], { type: "application/zip" }), "round-trip.vibread");
      const imported = await fetch(`${running.base}/api/missions/import`, { method: "POST", body: form });
      expect(imported.status).toBe(201);
      const body = (await imported.json()) as { missionId?: unknown };
      expect(typeof body.missionId).toBe("string");
      expect(body.missionId).not.toBe(running.mission.id);
      expect((await running.deps.store.getMission(body.missionId as string))?.ownerId).toBe("operator");
    } finally {
      running.close();
    }
  });

  it("returns the plain validation error for a non-project upload", async () => {
    const running = await server();
    try {
      const form = new FormData();
      form.set("file", new Blob(["not a zip"], { type: "application/zip" }), "bad.vibread");
      const response = await fetch(`${running.base}/api/missions/import`, { method: "POST", body: form });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "INVALID_PROJECT", message: "This file isn't a ViBread project" } });
    } finally {
      running.close();
    }
  });
});
