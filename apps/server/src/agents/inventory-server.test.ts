import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentCard, Role } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Actor, InventoryEntry, Mission, MissionDetail, ScanView } from "@vibread/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";

/**
 * Redesign S5 on the real server (SQLite stores, REST routes, /mcp, /a2a): missions copy the owner's inventory on every
 * creation path, the camera scan runs through the routes, and vibread_get_inventory serves the owner's parts. Claude is a
 * local stand-in for the per-user gateway (the owner's "connected account"), so nothing leaves the machine.
 */

const SCAN_GROUPS = {
  groups: [
    { typeId: "resistor", label: "beige resistors", count: 5, confidence: "high", box: [100, 120, 600, 300], bands: ["red", "red", "brown", "gold"] },
    { typeId: "led", label: "red LEDs", count: 3, confidence: "high", box: [900, 500, 400, 400], lensColor: "red" },
  ],
};

interface Seen {
  path: string;
  system: string;
  stream: boolean;
}

/** Anthropic Messages API stand-in: streams a short text for chat turns, returns the scan JSON for vision calls. */
async function claudeStub(): Promise<{ baseURL: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { stream?: boolean; model?: string; system?: { text: string }[] | string };
      const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((s) => s.text).join("\n");
      seen.push({ path: new URL(req.url ?? "", "http://stub").pathname, system, stream: Boolean(body.stream) });
      const usage = { input_tokens: 3, output_tokens: 4 };
      const text = system.includes("You identify electronics parts") ? JSON.stringify(SCAN_GROUPS) : "Got it — what should the light do when it's bright?";
      if (body.stream) {
        const events = [
          { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, server };
}

describe("inventory-driven missions, scan, and vibread_get_inventory (real server)", () => {
  let running: RunningServer;
  let base: string;
  let stub: Awaited<ReturnType<typeof claudeStub>>;
  let token: string;
  let entries: InventoryEntry[];

  beforeAll(async () => {
    stub = await claudeStub();
    process.env.LOG_LEVEL ??= "silent";
    process.env.VIBREAD_NO_STATIC = "1";
    process.env.VIBREAD_LAN_PAIRING = "off";
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    running = await startServer(
      loadConfig({
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: `/tmp/vb-s5a-test-${randomBytes(6).toString("hex")}`,
        BETTER_AUTH_SECRET: "b".repeat(40),
        VIBREAD_APPROVAL_SECRET: "a".repeat(40),
        VIBREAD_OMP_BIN: "omp-not-installed",
      }),
    );
    base = `http://127.0.0.1:${port}`;
    // The operator has "connected their Claude account": its endpoint is the local stand-in gateway.
    const accounts = running.context.ctx.claudeAccounts;
    Object.assign(accounts, {
      endpointFor: async (userId: string) => (userId === "operator" ? { baseURL: stub.baseURL, authToken: "gw" } : undefined),
      view: async () => ({ available: true, connected: true, using: "claude-account", email: "operator@example.com" }),
    });

    const upsert = await fetch(`${base}/api/inventory/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { typeId: "led", values: { color: "red", size: "5" }, quantity: 3, mode: "replace", source: "typed" },
          { typeId: "resistor", values: { ohms: 220 }, quantity: 10, mode: "replace", source: "typed" },
          { typeId: "ntc-thermistor", values: {}, quantity: 1, mode: "replace", source: "typed" },
          { typeId: "servo", values: {}, quantity: 1, mode: "replace", source: "typed" },
        ],
      }),
    });
    expect(upsert.status).toBe(201);
    entries = (await (await fetch(`${base}/api/inventory`)).json() as { entries: InventoryEntry[] }).entries;
    const minted = await fetch(`${base}/api/connections/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["circuits:read", "circuits:write"], ttlMinutes: 30 }),
    });
    token = ((await minted.json()) as { token: string }).token;
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    stub?.server.closeAllConnections();
    stub?.server.close();
  });

  async function mission(id: string): Promise<Mission> {
    return ((await (await fetch(`${base}/api/missions/${id}`)).json()) as MissionDetail).mission;
  }

  function expectOwnerInventory(m: Mission) {
    const modules = m.inventory.map((i) => [i.module, i.count, i.label ?? null]);
    expect(modules).toEqual(
      expect.arrayContaining([
        ["led", 3, null],
        ["resistor", 10, null],
        ["photoresistor", 1, expect.stringContaining("modelled as")],
      ]),
    );
    expect(m.inventory.some((i) => i.module === ("servo" as string))).toBe(false);
    expect(m.inventoryNotes?.join(" ")).toMatch(/servo/i);
  }

  it("web: POST /api/missions without parts copies the owner's inventory; inventoryEntryIds limits it", async () => {
    const all = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: "A night light" }) });
    expect(all.status).toBe(201);
    expectOwnerInventory(await mission(((await all.json()) as { id: string }).id));

    const ledId = entries.find((e) => e.typeId === "led")!.id;
    const some = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: "Just LEDs", inventoryEntryIds: [ledId] }) });
    const limited = await mission(((await some.json()) as { id: string }).id);
    expect(limited.inventory.map((i) => i.module)).toEqual(["led"]);
    expect(limited.inventoryNotes).toBeUndefined();
  });

  it("MCP: vibread_create_mission without parts gets the owner's inventory; vibread_get_inventory lists it by type", async () => {
    const client = new McpClient({ name: "s5", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const created = await client.callTool({ name: "vibread_create_mission", arguments: { brief: "A blinking light from Claude Code" } });
    expect(created.isError).not.toBe(true);
    const createdMission = JSON.parse((created.content as { text: string }[])[0]!.text) as Mission;
    expectOwnerInventory(await mission(createdMission.id));

    const inventory = await client.callTool({ name: "vibread_get_inventory", arguments: {} });
    const overview = JSON.parse((inventory.content as { text: string }[])[0]!.text) as { groups: { typeId: string; total: number; support: string }[] };
    expect(Object.fromEntries(overview.groups.map((g) => [g.typeId, [g.total, g.support]]))).toEqual({
      led: [3, "full"],
      resistor: [10, "full"],
      "ntc-thermistor": [1, "modelled"],
      servo: [1, "list-only"],
    });
    await client.close();
  });

  it("A2A: a new task's mission gets the owner's inventory (and the turn runs on the owner's Claude account)", async () => {
    const before = new Set(((await (await fetch(`${base}/api/missions`)).json()) as { id: string }[]).map((m) => m.id));
    const card = AgentCard.fromJSON(await (await fetch(`${base}/.well-known/agent-card.json`)).json());
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [
          new JsonRpcTransportFactory({
            fetchImpl: async (input, init) => {
              const headers = new Headers(init?.headers);
              headers.set("authorization", `Bearer ${token}`);
              return fetch(input, { ...init, headers });
            },
          }),
        ],
      }),
    );
    const client = await factory.createFromAgentCard(card);
    await client.sendMessage({
      tenant: "",
      metadata: {},
      message: {
        messageId: "s5-1",
        role: Role.ROLE_USER,
        parts: [{ content: { $case: "text" as const, value: "A dusk-sensing lamp" }, metadata: {}, filename: "", mediaType: "text/plain" }],
        taskId: "",
        contextId: "",
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
    });
    const created = ((await (await fetch(`${base}/api/missions`)).json()) as { id: string }[]).filter((m) => !before.has(m.id));
    expect(created).toHaveLength(1);
    expectOwnerInventory(await mission(created[0]!.id));
    expect(stub.seen.some((s) => s.stream && s.path === "/v1/messages")).toBe(true);
  });

  it("iMessage (CAPCOM's exact call: brief + imessage actor, no parts) gets the owner's inventory", async () => {
    const actor: Actor = { kind: "human", id: "operator", channel: "imessage" };
    const created = await running.context.ctx.missions.create({ brief: "a moon lamp", owner: actor, title: "a moon lamp" });
    expectOwnerInventory(await mission(created.id));
  });

  it("scan: photos → analyze (owner's Claude, high-res image) → review items with crops → accept updates the inventory", async () => {
    const photo = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: "#f6f6f2" } }).jpeg().toBuffer();
    const scan = (await (await fetch(`${base}/api/inventory/scans`, { method: "POST" })).json()) as ScanView;
    const form = new FormData();
    form.set("photo", new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), "kit.jpg");
    expect((await fetch(`${base}/api/inventory/scans/${scan.id}/photos`, { method: "POST", body: form })).status).toBe(200);

    const analyzed = await fetch(`${base}/api/inventory/scans/${scan.id}/analyze`, { method: "POST" });
    expect(analyzed.status).toBe(200);
    const view = (await analyzed.json()) as ScanView;
    expect(view.items.map((i) => [i.typeId, i.quantity, i.status, i.values])).toEqual([
      ["resistor", 5, "ready", { ohms: 220, bands: "4" }],
      ["led", 3, "ready", expect.objectContaining({ color: "red" })],
    ]);
    expect(view.items[1]!.existing).toMatchObject({ quantity: 3 });
    const vision = stub.seen.filter((s) => s.system.includes("You identify electronics parts"));
    expect(vision).toHaveLength(1);
    expect(vision[0]!.system).toContain("- ntc-thermistor: NTC thermistor");

    for (const [index, box] of SCAN_GROUPS.groups.map((g, i) => [i, g.box] as const)) {
      const crop = await fetch(`${base}${view.items[index]!.cropUrl}`);
      expect([index, crop.status, crop.headers.get("content-type")]).toEqual([index, 200, "image/jpeg"]);
      const meta = await sharp(Buffer.from(await crop.arrayBuffer())).metadata();
      expect(meta.width).toBe(Math.round(box[2]! * 1.24)); // 12 % margin each side
    }

    const accept = await fetch(`${base}/api/inventory/scans/${scan.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ index: 0, typeId: "resistor", values: { ohms: 220 }, quantity: 5, mode: "add" }] }),
    });
    expect(accept.status).toBe(200);
    const after = (await (await fetch(`${base}/api/inventory`)).json()) as { entries: InventoryEntry[] };
    expect(after.entries.find((e) => e.typeId === "resistor")?.quantity).toBe(15);
  });
});
