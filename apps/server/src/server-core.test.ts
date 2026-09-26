import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { GOLDEN } from "@vibread/fixtures";
import { loadConfig, derivePhoneUrl } from "./config.js";
import { openDatabase, type OpenDatabase } from "./db/index.js";
import { createMissionStore } from "./store/missions.js";
import { createMessageStore } from "./store/messages.js";
import { createApprovalBroker, SqlApprovalBroker } from "./services/approvals.js";
import { createMissionMachine } from "./services/machine.js";
import { createTokenService } from "./services/tokens.js";
import { createLinkService } from "./services/links.js";
import { createCapcomSpaceStore } from "./services/capcom-spaces.js";
import { createBenchAskStore } from "./services/bench-asks.js";
import { createCatalogService } from "./services/catalog.js";
import { createInventoryService } from "./services/inventory.js";
import { createScanService } from "./services/scans.js";
import { approvalOwnerMiddleware, missionOwnerMiddleware } from "./routes.js";
import { createApiErrorHandler } from "./main.js";

function makeDatabase(): { dir: string; opened: OpenDatabase } {
  const dir = `/tmp/vb-vitest-${randomUUID()}`;
  return { dir, opened: openDatabase(dir) };
}

describe("server core persistence", () => {
  it("derives phone URLs from env, HTTPS, LAN IPv4, or localhost fallback", () => {
    expect(derivePhoneUrl({ publicUrl: "http://localhost:8787", port: 8787, configured: "http://phone.local:8787/" }, {})).toBe("http://phone.local:8787");
    expect(derivePhoneUrl({ publicUrl: "https://vibread.example", port: 8787 }, {})).toBe("https://vibread.example");
    expect(derivePhoneUrl({ publicUrl: "http://localhost:8787", port: 8787 }, { eth0: [{ address: "192.168.1.24", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.24/24" }] })).toBe("http://192.168.1.24:8787");
    expect(derivePhoneUrl({ publicUrl: "http://localhost:8787", port: 8787 }, { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" }] })).toBe("http://localhost:8787");
    const dir = `/tmp/vb-phone-${randomUUID()}`;
    try {
      expect(() => loadConfig({ DATA_DIR: dir, PUBLIC_URL: "http://192.168.1.24:8787", BETTER_AUTH_SECRET: "x".repeat(40), VIBREAD_APPROVAL_SECRET: "y".repeat(40) })).toThrow("PUBLIC_URL must be https:// (or localhost). For phones on your Wi-Fi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips missions, revisions, messages, and deduplicated artifacts", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const fixture = GOLDEN[0];
      const mission = await store.createMission({ title: "Moon lamp", brief: fixture.brief, ownerId: "operator", inventory: fixture.inventory });
      const feed: string[] = [];
      const unsubscribe = store.subscribe((event) => feed.push(event.kind));
      const updated = await store.updateMission(mission.id, { inventory: fixture.inventory.slice(0, 1) });
      expect(updated.inventory).toHaveLength(1);
      await store.appendEvent({ missionId: mission.id, channel: "system", actor: { kind: "system", id: "test", channel: "system" }, kind: "test", text: "test" });
      expect(feed).toContain("test");
      unsubscribe();
      const author = { kind: "human" as const, id: "operator", channel: "web" as const };
      const first = await store.createRevision(mission.id, { circuit: fixture.circuit, suite: fixture.suite, author });
      const second = await store.createRevision(mission.id, { circuit: fixture.circuit, suite: fixture.suite, author });
      expect(second.n).toBe(first.n + 1);
      const firstHash = await store.putArtifact(new Uint8Array([1, 2, 3]), "application/octet-stream");
      const secondHash = await store.putArtifact(new Uint8Array([1, 2, 3]), "application/octet-stream");
      expect(secondHash).toBe(firstHash);
      expect((await store.getArtifact(firstHash))?.data).toEqual(new Uint8Array([1, 2, 3]));
      const messages = createMessageStore({ db: opened.db, sqlite: opened.sqlite });
      await messages.save(mission.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }]);
      expect((await messages.list(mission.id))[0]?.parts[0]).toEqual({ type: "text", text: "hello" });
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects unauthenticated and cross-owner mission/approval access before handlers", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "Private", brief: "Private", ownerId: "owner", inventory: [] });
      const context = { store } as Parameters<typeof missionOwnerMiddleware>[0];
      const otherResponse = { locals: { user: { id: "other", name: "Other" } } } as unknown as Response;
      let ownerError: unknown;
      await missionOwnerMiddleware(context)({ params: { id: mission.id } } as unknown as Request, otherResponse, (error) => {
        ownerError = error;
      });
      expect(ownerError).toMatchObject({ status: 404, code: "MISSION_NOT_FOUND" });
      const anonymousResponse = { locals: {} } as unknown as Response;
      let anonymousError: unknown;
      await missionOwnerMiddleware(context)({ params: { id: mission.id } } as unknown as Request, anonymousResponse, (error) => {
        anonymousError = error;
      });
      expect(anonymousError).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
      const broker = createApprovalBroker({ db: opened.db, sqlite: opened.sqlite });
      const approval = await broker.requestBench({
        missionId: mission.id,
        action: "run-selftest",
        input: {},
        revisionHash: "r1",
        actor: { kind: "agent", id: "agent", channel: "mcp" },
        summary: "Private",
        consequence: "Private",
      });
      let approvalError: unknown;
      await approvalOwnerMiddleware({ store, broker } as Parameters<typeof approvalOwnerMiddleware>[0])(
        { params: { approvalId: approval.id } } as unknown as Request,
        otherResponse,
        (error) => {
          approvalError = error;
        },
      );
      expect(approvalError).toMatchObject({ status: 404, code: "MISSION_NOT_FOUND" });
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists CAPCOM space identity and mission attachment", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const spaces = createCapcomSpaceStore({ db: opened.db, sqlite: opened.sqlite });
      const saved = await spaces.put({ spaceId: "space-1", handle: "+1555", userId: "operator" });
      expect(saved.missionId).toBeUndefined();
      await spaces.setMission(saved.spaceId, "mission-1");
      expect((await spaces.get(saved.spaceId))?.missionId).toBe("mission-1");
      expect((await spaces.listForMission("mission-1"))[0]?.handle).toBe("+1555");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sanitizes unexpected filesystem errors in API responses", () => {
    let statusCode = 0;
    let payload: unknown;
    const response = {
      headersSent: false,
      status(value: number) {
        statusCode = value;
        return response;
      },
      json(value: unknown) {
        payload = value;
        return response;
      },
    } as unknown as Response;
    const handler = createApiErrorHandler({ error: () => undefined } as unknown as Logger);
    const fsError = Object.assign(new Error("ENOENT: open /secret/server.sqlite"), { code: "ENOENT", errno: -2 });
    handler(fsError, {} as Request, response, () => undefined);
    expect(statusCode).toBe(500);
    expect(payload).toEqual({ error: { code: "INTERNAL_ERROR", message: "internal server error" } });
  });



  it("bench requests: dedupe, first decision wins, remote actors can't decide, iMessage pre-approval, expiry", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "Approvals", brief: "Approvals", ownerId: "operator", inventory: [] });
      const broker = createApprovalBroker({ db: opened.db, sqlite: opened.sqlite });
      const actor = { kind: "human" as const, id: "operator", channel: "web" as const };
      const agent = { kind: "agent" as const, id: "agent", channel: "mcp" as const };
      const ask = (action: string, revisionHash = "r1") =>
        broker.requestBench({ missionId: mission.id, action, input: {}, revisionHash, actor: agent, summary: action, consequence: "Runs only after a human clicks Start" });
      const pending = await ask("flash-app");
      expect([pending.actionClass, pending.status]).toEqual(["physical", "pending"]);
      // An identical request while one is open is the same request.
      expect((await ask("flash-app")).id).toBe(pending.id);
      expect((await ask("flash-app", "r2")).id).not.toBe(pending.id);
      await expect(broker.decide(pending.id, "approve-once", { kind: "human", id: "remote", channel: "mcp" })).rejects.toThrow("remote actors");
      const denied = await broker.decide(pending.id, "deny", actor);
      expect(denied.status).toBe("denied");
      expect((await broker.decide(pending.id, "approve-once", actor)).status).toBe("denied");
      // After a denial, asking again opens a new request.
      expect((await ask("flash-app")).id).not.toBe(pending.id);
      const selftest = await ask("run-selftest");
      const preapproved = await broker.decide(selftest.id, "approve-once", { kind: "human", id: "imessage-user", channel: "imessage" });
      expect(preapproved.preApprovedBy?.channel).toBe("imessage");
      expect((await ask("run-selftest")).id).toBe(selftest.id);
      const expiring = await ask("rail-checkpoint", "r2");
      opened.sqlite.prepare('UPDATE "approvals" SET "expiresAt" = ? WHERE "id" = ?').run(Date.now() - 1, expiring.id);
      expect((await broker.get(expiring.id))?.status).toBe("expired");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("lists iMessage pre-approvals and consumes them only on the web bench start", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "Bench", brief: "Bench", ownerId: "operator", inventory: [] });
      const broker = new SqlApprovalBroker({ db: opened.db, sqlite: opened.sqlite, store });
      const request = await broker.requestBench({
        missionId: mission.id,
        action: "run-selftest",
        input: {},
        revisionHash: "r1",
        actor: { kind: "agent", id: "agent", channel: "mcp" },
        summary: "Run self-test",
        consequence: "Runs only after a human clicks Start",
      });
      await broker.decide(request.id, "approve-once", { kind: "human", id: "imessage", channel: "imessage" });
      const listed = await broker.listBenchRequests(mission.id, "r1", 1);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.status).toBe("approved");
      expect(listed[0]?.preApprovedBy?.channel).toBe("imessage");
      const started = await broker.startBenchRequest({
        approvalId: request.id,
        missionId: mission.id,
        revisionHash: "r1",
        revision: 1,
        actor: { kind: "human", id: "operator", channel: "web" },
      });
      expect(started).toEqual({ id: request.id, action: "run-selftest", revision: 1 });
      await expect(broker.startBenchRequest({
        approvalId: request.id,
        missionId: mission.id,
        revisionHash: "r1",
        revision: 1,
        actor: { kind: "human", id: "operator", channel: "web" },
      })).rejects.toMatchObject({ status: 409, code: "request_not_runnable" });
      expect((await broker.get(request.id))?.status).toBe("consumed");
      expect((await store.listEvents(mission.id)).some((event) => event.kind === "bench.request.started")).toBe(true);
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("restores the mission machine snapshot after a database restart", async () => {
    const { dir, opened } = makeDatabase();
    const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
    const mission = await store.createMission({ title: "Restart", brief: "Restart", ownerId: "operator", inventory: [] });
    const machine = createMissionMachine({ db: opened.db, sqlite: opened.sqlite, store });
    await machine.send(mission.id, { type: "BRIEF_RECEIVED" });
    await machine.send(mission.id, { type: "DESIGN_STARTED" });
    const events = await store.listEvents(mission.id);
    expect(events.some((event) => event.kind === "phase.changed" && event.text === "Design work started")).toBe(true);
    const reopened = openDatabase(dir);
    try {
      const store2 = createMissionStore({ db: reopened.db, sqlite: reopened.sqlite, dataDir: dir });
      const machine2 = createMissionMachine({ db: reopened.db, sqlite: reopened.sqlite, store: store2 });
      expect(await machine2.phase(mission.id)).toBe("DESIGN");
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("moves a fresh mission to Go/No-Go when an external agent submits a design", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "External design", brief: "External design", ownerId: "operator", inventory: [] });
      const machine = createMissionMachine({ db: opened.db, sqlite: opened.sqlite, store });
      expect(await machine.send(mission.id, { type: "DESIGN_READY", revision: 1 })).toBe("GONOGO");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts verification from a partially assembled mission", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "Partial build", brief: "Partial build", ownerId: "operator", inventory: [] });
      const machine = createMissionMachine({ db: opened.db, sqlite: opened.sqlite, store });
      await machine.send(mission.id, { type: "BRIEF_RECEIVED" });
      await machine.send(mission.id, { type: "DESIGN_STARTED" });
      await machine.send(mission.id, { type: "DESIGN_READY", revision: 1 });
      await machine.send(mission.id, { type: "RELEASED", revision: 1 });
      await machine.send(mission.id, { type: "VERIFY_STARTED" });
      expect(await machine.send(mission.id, { type: "VERIFY_PASSED" })).toBe("LAUNCH");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("relays bench asks with first-valid-answer and expiry semantics", () => {
    vi.useFakeTimers();
    try {
      const asks = createBenchAskStore();
      asks.open({ missionId: "m1", askId: "a1", test: "button.interactive", kind: "press-hold", prompt: "Press the button", choices: ["yes", "no"], timeoutMs: 1000 });
      expect(asks.answer("m1", "a1", "yes", { kind: "human", id: "imessage", channel: "imessage" })).toBe(true);
      expect(asks.answer("m1", "a1", "no", { kind: "human", id: "other", channel: "web" })).toBe(false);
      expect(asks.get("m1", "a1")?.answeredBy?.channel).toBe("imessage");
      expect(asks.answer("m1", "a1", "maybe", { kind: "human", id: "other", channel: "web" })).toBe(false);
      asks.open({ missionId: "m2", askId: "a2", test: "light.relative", kind: "cover", prompt: "Cover sensor", choices: ["done"], timeoutMs: 1 });
      vi.advanceTimersByTime(2);
      expect(asks.answer("m2", "a2", "done", { kind: "human", id: "imessage", channel: "imessage" })).toBe(false);
      expect(asks.get("m2", "a2")?.status).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges inventory identities and completes a fake scan lifecycle", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const catalog = createCatalogService({ db: opened.db, sqlite: opened.sqlite });
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const inventory = createInventoryService({ db: opened.db, sqlite: opened.sqlite, catalog, store });
      const scans = createScanService({ db: opened.db, sqlite: opened.sqlite, store });
      const resistor = (await catalog.types("operator")).find((type) => type.id === "resistor");
      if (!resistor) throw new Error("resistor catalog type missing");
      const first = await inventory.upsert("operator", { items: [{ typeId: resistor.id, values: { ohms: 220 }, quantity: 2, mode: "add", source: "typed" }] });
      await inventory.upsert("operator", { items: [{ typeId: resistor.id, values: { ohms: 220 }, quantity: 3, mode: "add", source: "typed" }] });
      expect((await inventory.entries("operator")).find((entry) => entry.id === first[0]?.id)?.quantity).toBe(5);
      const scan = await scans.create("operator");
      await scans.addPhoto("operator", scan.id, "photo-hash");
      const ready = await scans.analyze("operator", scan.id, { observations: [{ photoIndex: 0, typeId: resistor.id, label: "220 ohm resistor", count: 1, confidence: "high", box: [0, 0, 10, 10] }], analyzed: [{ hash: "analyzed-hash", width: 100, height: 100 }] }, await catalog.types("operator"), await inventory.entries("operator"));
      expect(ready.status).toBe("ready");
      expect(ready.items[0]?.cropUrl).toContain("/crops/0");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mints, verifies, revokes, expires tokens and redeems links once", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const tokens = createTokenService({ db: opened.db, sqlite: opened.sqlite });
      const minted = await tokens.mint({ userId: "operator", scopes: ["circuits:read"], ttlMinutes: 1 });
      expect(minted.token.startsWith("vb_")).toBe(true);
      expect((await tokens.verify(minted.token))?.scopes).toEqual(["circuits:read"]);
      await tokens.revoke(minted.id, "operator");
      expect(await tokens.verify(minted.token)).toBeNull();
      const links = createLinkService({ db: opened.db, sqlite: opened.sqlite });
      const code = await links.createCode("operator");
      expect(await links.redeem(code.code, "imessage:+1555")).toEqual({ userId: "operator" });
      expect(await links.redeem(code.code, "imessage:+1555")).toBeNull();
      expect(await links.userForHandle("imessage:+1555")).toBe("operator");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
