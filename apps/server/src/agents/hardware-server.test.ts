import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HardwareIdentification, HardwareView, Mission, MissionDetail } from "@vibread/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";
import { missionHardware } from "../services/hardware.js";
import { designSystemPrompt } from "./prompts.js";

/**
 * Issue #23 on the real server: "Your hardware" is saved per user, new missions snapshot it (the design agent is told to
 * build for it, part variants ride in the parts' params), and a photo is identified through pi-ai against a local
 * Anthropic stand-in, then checked against the catalogue. Without a Claude credential the photo route says so (the web
 * falls back to the manual pickers).
 */

/** What the stand-in "sees": a 17-row board without rails that it wrongly calls a 400-point one. */
const ANSWER = { kind: "breadboard", id: "bb-400", confidence: "high", reasons: ["small white board"], description: "a small breadboard", rows: 17, rails: false };

interface ClaudeStub {
  baseURL: string;
  /** System prompts of every request, in order. */
  systems: string[];
  server: Server;
}

async function claudeStub(): Promise<ClaudeStub> {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string; system?: { text: string }[] | string; tool_choice?: { type: string; name?: string } };
      const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((s) => s.text).join("\n");
      systems.push(system);
      const usage = { input_tokens: 3, output_tokens: 4 };
      const forced = body.tool_choice?.type === "tool" ? body.tool_choice.name : "identify_hardware";
      const events = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_hw", name: forced, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ANSWER) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systems, server };
}

interface Started {
  running: RunningServer;
  base: string;
}

async function start(env: Record<string, string>): Promise<Started> {
  process.env.LOG_LEVEL ??= "silent";
  process.env.VIBREAD_NO_STATIC = "1";
  process.env.VIBREAD_LAN_PAIRING = "off";
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const running = await startServer(
    loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: `/tmp/vb-hw23-test-${randomBytes(6).toString("hex")}`,
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
      ANTHROPIC_API_KEY: "",
      ...env,
    }),
  );
  return { running, base: `http://127.0.0.1:${port}` };
}

async function photoForm(kind?: string): Promise<FormData> {
  const jpeg = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eeeeee" } }).jpeg().toBuffer();
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "board.jpg");
  if (kind) form.append("kind", kind);
  return form;
}

describe("your hardware (real server)", () => {
  let running: RunningServer;
  let base: string;
  let stub: ClaudeStub;
  let bare: Started;

  beforeAll(async () => {
    stub = await claudeStub();
    ({ running, base } = await start({ ANTHROPIC_BASE_URL: stub.baseURL }));
    await running.context.ctx.claudeAccounts
      .credentials("operator")
      .modify("anthropic", async () => ({ type: "oauth", access: "sk-ant-oat01-operator", refresh: "sk-ant-ort01-operator", expires: Date.now() + 3_600_000 }));
    bare = await start({});
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    await bare?.running.close();
    stub?.server.closeAllConnections();
    stub?.server.close();
  });

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  it("defaults to the inventory's breadboard, then saves what the person picks", async () => {
    const fresh = await json<HardwareView>(await fetch(`${base}/api/inventory/hardware`));
    expect(fresh).toMatchObject({ hardware: { breadboard: "bb-830", board: "uno-r3-genuine", parts: {} }, source: { breadboard: "default", board: "default" }, claude: "connected" });

    await fetch(`${base}/api/inventory/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ typeId: "breadboard", values: { size: "400" }, quantity: 1, mode: "replace", source: "typed" }, { typeId: "led", values: { color: "red" }, quantity: 4, mode: "replace", source: "typed" }] }),
    });
    expect(await json<HardwareView>(await fetch(`${base}/api/inventory/hardware`))).toMatchObject({ hardware: { breadboard: "bb-400" }, source: { breadboard: "inventory", board: "default" } });

    const bad = await fetch(`${base}/api/inventory/hardware`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ breadboard: "bb-1660", board: "uno-r3-genuine" }) });
    expect(bad.status).toBe(400);
    const badVariant = await fetch(`${base}/api/inventory/hardware`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ breadboard: "bb-170", board: "uno-r3-genuine", parts: { led: "2leg" } }) });
    expect(badVariant.status).toBe(400);

    const saved = await fetch(`${base}/api/inventory/hardware`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ breadboard: "bb-170", board: "uno-r3-ch340", parts: { led: "3mm" } }) });
    expect(saved.status).toBe(200);
    expect(await json<HardwareView>(saved)).toMatchObject({ hardware: { breadboard: "bb-170", board: "uno-r3-ch340", parts: { led: "3mm" } }, source: { breadboard: "saved", board: "saved" } });
  });

  it("gives new missions the saved hardware: parts carry their variant and the design agent builds for the board", async () => {
    const created = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: "Blink a light" }) });
    const { id } = await json<{ id: string }>(created);
    const mission = (await json<MissionDetail>(await fetch(`${base}/api/missions/${id}`))).mission;
    expect(mission.inventory.find((item) => item.module === "led")?.params).toEqual({ color: "red", variant: "3mm" });

    const hardware = await missionHardware(running.context.ctx.store, id);
    expect(hardware).toEqual({ breadboard: "bb-170", board: "uno-r3-ch340", parts: { led: "3mm" } });
    const events = await running.context.ctx.store.listEvents(id);
    expect(events.find((event) => event.kind === "mission.hardware")?.text).toBe("Building on your 170-point mini board with your Uno R3 (CH340) (3 mm LED).");

    const prompt = designSystemPrompt({ mission: mission as Mission, revision: null, hardware });
    expect(prompt).toContain('Set "breadboard": {"profile": "bb-170"}');
    expect(prompt).toContain('Set "board": {"profile": "uno-r3-atmega328p-5v"}');
    expect(prompt).toContain('params.variant "3mm"');
    expect(prompt).toContain("no power rails");

    // Changing the hardware later leaves this mission's snapshot alone.
    await fetch(`${base}/api/inventory/hardware`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ breadboard: "bb-830-split", board: "nano-old", parts: {} }) });
    expect((await missionHardware(running.context.ctx.store, id))?.breadboard).toBe("bb-170");
  });

  it("identifies a photo through Claude and corrects the pick from the rows it counted", async () => {
    const response = await fetch(`${base}/api/inventory/hardware/identify`, { method: "POST", body: await photoForm("breadboard") });
    expect(response.status).toBe(200);
    const result = await json<HardwareIdentification>(response);
    expect(result).toMatchObject({ kind: "breadboard", profileOrVariantId: "bb-170", confidence: "medium" });
    expect(result.reasons[0]).toBe("small white board");
    expect(result.reasons.at(-1)).toContain("170-point mini board");
    expect(stub.systems.at(-1)).toContain("The person says the photo shows a breadboard");
    expect(stub.systems.at(-1)).toContain("bb-830-split");

    const badKind = await fetch(`${base}/api/inventory/hardware/identify`, { method: "POST", body: await photoForm("spaceship") });
    expect(badKind.status).toBe(400);
  });

  it("says Claude isn't connected when there is no credential (the page offers the manual pick)", async () => {
    expect((await json<HardwareView>(await fetch(`${bare.base}/api/inventory/hardware`))).claude).toBe("missing");
    const response = await fetch(`${bare.base}/api/inventory/hardware/identify`, { method: "POST", body: await photoForm() });
    expect(response.status).toBe(503);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("claude_not_connected");
  });
});
