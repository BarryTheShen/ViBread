import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { policyFor } from "@vibread/core";
import { openDatabase, type OpenDatabase } from "./db/index.js";
import { createMissionStore } from "./store/missions.js";
import { createMessageStore } from "./store/messages.js";
import { createApprovalBroker } from "./services/approvals.js";
import { createMissionMachine } from "./services/machine.js";
import { createTokenService } from "./services/tokens.js";
import { createLinkService } from "./services/links.js";

function makeDatabase(): { dir: string; opened: OpenDatabase } {
  const dir = `/tmp/vb-vitest-${randomUUID()}`;
  return { dir, opened: openDatabase(dir) };
}

describe("server core persistence", () => {
  it("round-trips missions, revisions, messages, and deduplicated artifacts", async () => {
    const { dir, opened } = makeDatabase();
    try {
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const fixture = GOLDEN[0];
      const mission = await store.createMission({ title: "Moon lamp", brief: fixture.brief, ownerId: "operator", inventory: fixture.inventory, mode: "review" });
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

  it("enforces policy, expiry, first decision, one-shot consume, and remote/physical boundaries", async () => {
    const { dir, opened } = makeDatabase();
    try {
      expect(policyFor("plan", "state-changing")).toBe("denied");
      expect(policyFor("ask", "state-changing")).toBe("user-approval");
      expect(policyFor("autopilot", "release", { allGo: true })).toBe("approved");
      expect(policyFor("review", "physical")).toBe("bench-click");
      const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
      const mission = await store.createMission({ title: "Approvals", brief: "Approvals", ownerId: "operator", inventory: [], mode: "ask" });
      const broker = createApprovalBroker({ db: opened.db, sqlite: opened.sqlite });
      const actor = { kind: "human" as const, id: "operator", channel: "web" as const };
      const pending = await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "state-changing", action: "write", input: { x: 1 }, revisionHash: "r1", actor, summary: "Write", consequence: "Changes" });
      if (!pending.request) throw new Error("missing request");
      await expect(broker.decide(pending.request.id, "approve-once", { kind: "human", id: "remote", channel: "mcp" })).rejects.toThrow("remote actors");
      const approved = await broker.decide(pending.request.id, "approve-once", actor);
      expect(approved.status).toBe("approved");
      expect((await broker.decide(pending.request.id, "deny", actor)).status).toBe("approved");
      expect(await broker.consume(pending.request.id, pending.request.actionHash)).toBe(true);
      expect(await broker.consume(pending.request.id, pending.request.actionHash)).toBe(false);
      const standing = await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "state-changing", action: "always-write", input: { x: 1 }, revisionHash: "r1", actor, summary: "Always write", consequence: "Changes" });
      if (!standing.request) throw new Error("missing standing request");
      await broker.decide(standing.request.id, "approve-mission", actor);
      expect((await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "state-changing", action: "always-write", input: { x: 99 }, revisionHash: "r2", actor, summary: "Always write", consequence: "Changes" })).outcome).toBe("approved");
      const release = await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "release", action: "release", input: {}, revisionHash: "r1", actor, summary: "Release", consequence: "Publishes" });
      if (!release.request) throw new Error("missing release request");
      await broker.decide(release.request.id, "approve-mission", actor);
      expect((await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "release", action: "release", input: {}, revisionHash: "r2", actor, summary: "Release", consequence: "Publishes" })).outcome).toBe("approved");
      await store.updateMission(mission.id, { mode: "review" });
      await store.updateMission(mission.id, { mode: "ask" });
      expect((await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "state-changing", action: "always-write", input: { x: 99 }, revisionHash: "r2", actor, summary: "Always write", consequence: "Changes" })).outcome).toBe("user-approval");
      const physical = await broker.evaluate({ missionId: mission.id, mode: "review", actionClass: "physical", action: "flash", input: {}, revisionHash: "r1", actor, summary: "Flash", consequence: "Runs on bench" });
      if (!physical.request) throw new Error("missing physical request");
      const preapproved = await broker.decide(physical.request.id, "approve-once", { kind: "human", id: "imessage-user", channel: "imessage" });
      expect(preapproved.preApprovedBy?.channel).toBe("imessage");
      expect(await broker.consume(preapproved.id, preapproved.actionHash)).toBe(false);
      const expiring = await broker.evaluate({ missionId: mission.id, mode: "ask", actionClass: "bom-change", action: "bom", input: {}, revisionHash: "r2", actor, summary: "BOM", consequence: "Changes" });
      if (!expiring.request) throw new Error("missing expiring request");
      opened.sqlite.prepare('UPDATE "approvals" SET "expiresAt" = ? WHERE "id" = ?').run(Date.now() - 1, expiring.request.id);
      expect((await broker.get(expiring.request.id))?.status).toBe("expired");
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the mission machine snapshot after a database restart", async () => {
    const { dir, opened } = makeDatabase();
    const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: dir });
    const mission = await store.createMission({ title: "Restart", brief: "Restart", ownerId: "operator", inventory: [], mode: "review" });
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
