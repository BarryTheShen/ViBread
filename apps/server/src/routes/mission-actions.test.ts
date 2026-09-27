import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MissionStore, RevisionResults } from "@vibread/core";
import type { UIMessage } from "ai";
import { GOLDEN } from "@vibread/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { createAgentRuntime, STOP_DRAIN_MS, type AgentModels } from "../agents/index.js";
import { mockModels, scriptedDesign, scriptedJson, testDeps } from "../agents/testing.js";
import type { MessageStore } from "../store/messages.js";
import { missionOwnerMiddleware, mountApi } from "../routes.js";

const fixture = GOLDEN.find((golden) => golden.key === "moon-phase-lamp")!;

type TestServer = {
  base: string;
  store: MissionStore;
  messages: MessageStore;
  runtime: { stop: (missionId: string) => Promise<boolean> };
  order: string[];
  deleted: { id?: string };
  close(): Promise<void>;
};

async function server(): Promise<TestServer> {
  const deps = testDeps();
  const order: string[] = [];
  const deleted: { id?: string } = {};
  const store = deps.store as MissionStore & { deleteMission(id: string): void };
  store.deleteMission = (id) => {
    order.push("delete");
    deleted.id = id;
  };
  const pipeline = {
    async evaluate(missionId: string, n: number): Promise<RevisionResults> {
      const revision = await store.getRevision(missionId, n);
      const result = revision?.results ?? { reports: [], artifacts: {} };
      await store.saveResults(missionId, n, result);
      return result;
    },
    async idle(): Promise<void> {},
  };
  const stop = vi.fn(async (missionId: string) => {
    order.push("stop");
    return Boolean(missionId);
  });
  const runtime = { pipeline, stop };
  const ctx = {
    ...deps,
    config: { ...deps.config, singleOperator: false },
    runtime,
    log: { warn: () => undefined },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = req.header("x-user") ?? "owner";
    res.locals.user = { id, name: id };
    next();
  });
  app.use("/api/missions/:id", missionOwnerMiddleware(ctx));
  mountApi(app, ctx);
  app.use((error: { status?: number; code?: string; message?: string }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? "INTERNAL_ERROR", message: error.message ?? "internal" } });
  });
  const listener = await new Promise<Server>((resolve) => resolve(app.listen(0)));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    store,
    messages: deps.messages,
    runtime: { stop },
    order,
    deleted,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("mission action routes", () => {
  it("duplicates a mission's revisions and chat without changing the original, and enforces ownership", async () => {
    const running = await server();
    try {
      const original = await running.store.createMission({ title: "Moon lamp", brief: fixture.brief, ownerId: "owner", inventory: fixture.inventory });
      const first = await running.store.createRevision(original.id, {
        circuit: fixture.circuit,
        suite: fixture.suite,
        author: { kind: "human", id: "owner", channel: "web" },
        note: "first design",
      });
      const second = await running.store.createRevision(original.id, {
        circuit: fixture.circuit,
        suite: fixture.suite,
        author: { kind: "human", id: "owner", channel: "web" },
        parent: first.n,
        note: "second design",
      });
      await running.store.updateMission(original.id, { currentRevision: second.n });
      const chat: UIMessage[] = [{ id: "chat-1", role: "user", parts: [{ type: "text", text: "hello" }] }];
      await running.messages.save(original.id, chat);
      await running.store.appendEvent({
        missionId: original.id,
        channel: "web",
        actor: { kind: "human", id: "owner", name: "owner", channel: "web" },
        kind: "release.override",
        text: "Released with override",
        revision: second.n,
      });

      const denied = await fetch(`${running.base}/api/missions/${original.id}/duplicate`, { method: "POST", headers: { "x-user": "other" } });
      expect(denied.status).toBe(404);
      expect((await running.store.listMissions("owner")).map((mission) => mission.id)).toEqual([original.id]);

      const response = await fetch(`${running.base}/api/missions/${original.id}/duplicate`, { method: "POST" });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { missionId: string };
      expect(body.missionId).not.toBe(original.id);
      const copy = await running.store.getMission(body.missionId);
      expect(copy).toMatchObject({ title: "Moon lamp (copy)", brief: fixture.brief, ownerId: "owner", currentRevision: second.n });
      const revisions = await running.store.listRevisions(body.missionId);
      expect(revisions).toHaveLength(2);
      expect(revisions.map((revision) => revision.n)).toEqual([1, 2]);
      expect(revisions.map((revision) => revision.note)).toEqual(["first design", "second design"]);
      expect(await running.messages.list(body.missionId)).toEqual(chat);
      expect(await running.store.getMission(original.id)).toMatchObject({ id: original.id, title: "Moon lamp", currentRevision: second.n });
      expect(await running.store.listRevisions(original.id)).toHaveLength(2);
      const copyEvents = await running.store.listEvents(body.missionId);
      // The copy keeps the safety-override row the header chip keys off, and says it's a copy, not a file import.
      expect(copyEvents.filter((event) => event.kind === "release.override").map((event) => event.revision)).toEqual([second.n]);
      expect(copyEvents.filter((event) => event.kind === "project.imported").map((event) => event.text)).toEqual(["Made as a copy of “Moon lamp”"]);
      expect(copyEvents.some((event) => event.text.startsWith("Imported from"))).toBe(false);
    } finally {
      await running.close();
    }
  });

  it("stops the mission runtime before deleting it", async () => {
    const running = await server();
    try {
      const mission = await running.store.createMission({ title: "Delete me", brief: "test", ownerId: "owner", inventory: [] });
      const response = await fetch(`${running.base}/api/missions/${mission.id}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(running.runtime.stop).toHaveBeenCalledWith(mission.id);
      expect(running.order).toEqual(["stop", "delete"]);
      expect(running.deleted.id).toBe(mission.id);
    } finally {
      await running.close();
    }
  });
});

describe("agent runtime stop", () => {
  const open: Server[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const listener of open.splice(0)) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  /** A runtime whose design model is `design`, with one mission owned by "operator" and a chat turn in flight. */
  async function turnInSetup(design: AgentModels["design"]) {
    const deps = testDeps();
    let reached!: () => void;
    const designCalled = new Promise<void>((resolve) => (reached = resolve));
    const models: AgentModels = {
      ...mockModels(scriptedDesign([]), scriptedJson([])),
      design: (ownerId, trace) => {
        reached();
        return design(ownerId, trace);
      },
    };
    const runtime = createAgentRuntime({ ...deps, models });
    const mission = await runtime.missions.create({ brief: fixture.brief, inventory: fixture.inventory, owner: { kind: "human", id: "operator", name: "Operator", channel: "web" } });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.user = { id: "operator", name: "Operator" };
      next();
    });
    runtime.mountChat(app);
    const listener = app.listen(0, "127.0.0.1");
    open.push(listener);
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const request = fetch(`${base}/api/missions/${mission.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    }).catch(() => undefined);
    await designCalled;
    return { runtime, missionId: mission.id, request };
  }

  it("returns as soon as a turn that fails to start settles", async () => {
    let fail!: (error: Error) => void;
    const { runtime, missionId, request } = await turnInSetup(() => new Promise((_resolve, reject) => (fail = reject)));
    const started = Date.now();
    const stopping = runtime.stop(missionId);
    fail(new Error("Claude is not connected"));
    await expect(stopping).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(STOP_DRAIN_MS);
    await request;
  });

  it("stops waiting after the drain bound when a turn never settles", async () => {
    const { runtime, missionId } = await turnInSetup(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let settled = false;
    const stopping = runtime.stop(missionId).then((stopped) => {
      settled = true;
      return stopped;
    });
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toBe(true);
  });
});
