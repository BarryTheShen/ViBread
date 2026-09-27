import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { startServer, type RunningServer } from "../main.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OPERATOR: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const HEX = ":00000001FF\n";

// Stands in for the bundled arduino-cli at the process boundary: prints a board list with one CH340 and one mouse,
// records its argv, and answers `upload` like avrdude does for FAKE_CLI_UPLOAD = ok | busy | sync.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLI_ARGV, JSON.stringify(args) + "\\n");
if (args.includes("board")) {
  process.stdout.write(JSON.stringify({ detected_ports: [
    { port: { address: "COM3", protocol: "serial", properties: { vid: "0x1A86", pid: "0x7523" } } },
    { port: { address: "COM7", protocol: "serial", properties: { vid: "0x046D", pid: "0xC52B" } } },
  ] }));
  process.exit(0);
}
const hex = fs.readFileSync(args[args.indexOf("--input-file") + 1], "utf8");
const mode = process.env.FAKE_CLI_UPLOAD;
console.log("Using port            : " + args[args.indexOf("--port") + 1]);
if (mode === "busy") { console.error("OS error: cannot open port \\\\\\\\.\\\\COM3: Access is denied."); process.exit(1); }
if (mode === "sync") { console.error("Error: stk500_getsync() attempt 10 of 10: not in sync: resp=0x00"); process.exit(1); }
console.log("Device signature = 1E 95 0F (ATmega328P)");
console.log(hex.length + " bytes of flash written");
process.exit(0);
`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("native flash routes", () => {
  let running: RunningServer;
  let base: string;
  let missionId: string;
  let dir: string;
  const saved = { cli: process.env.VIBREAD_ARDUINO_CLI, argv: process.env.FAKE_CLI_ARGV, upload: process.env.FAKE_CLI_UPLOAD, pairing: process.env.VIBREAD_LAN_PAIRING };
  const argvLog = (): string[][] => readFileSync(process.env.FAKE_CLI_ARGV!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const flash = (body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(`${base}/api/missions/${missionId}/bench/native-flash`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-native-flash-"));
    const cli = join(dir, "arduino-cli");
    writeFileSync(cli, FAKE_CLI);
    chmodSync(cli, 0o755);
    process.env.VIBREAD_ARDUINO_CLI = cli;
    process.env.FAKE_CLI_ARGV = join(dir, "argv.jsonl");
    // Pairing off: the LAN guard lets every client through, so these routes' own loopback check is what's tested.
    process.env.VIBREAD_LAN_PAIRING = "off";
    const port = await freePort();
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: join(dir, `data-${randomBytes(4).toString("hex")}`),
      BETTER_AUTH_SECRET: "b".repeat(40),
      VIBREAD_APPROVAL_SECRET: "a".repeat(40),
    });
    process.env.LOG_LEVEL ??= "silent";
    process.env.VIBREAD_NO_STATIC = "1";
    running = await startServer(config);
    base = `http://127.0.0.1:${port}`;
    const { ctx } = running.context;
    const mission = await ctx.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: OPERATOR });
    const revision = await ctx.store.createRevision(mission.id, { circuit: golden.circuit, suite: golden.suite, author: OPERATOR });
    // The bench HEX already built for this revision (as POST /bench/firmware leaves it), so no compile runs here.
    const hash = await ctx.store.putArtifact(HEX, "text/plain; charset=utf-8");
    await ctx.store.saveResults(mission.id, revision.n, { artifacts: { "bench.hex": hash } });
    await ctx.store.updateMission(mission.id, { currentRevision: revision.n, releasedRevision: revision.n });
    missionId = mission.id;
  }, 60_000);

  beforeEach(() => {
    writeFileSync(process.env.FAKE_CLI_ARGV!, "");
    process.env.FAKE_CLI_UPLOAD = "ok";
  });

  afterAll(async () => {
    await running?.close();
    for (const [key, value] of [["VIBREAD_ARDUINO_CLI", saved.cli], ["FAKE_CLI_ARGV", saved.argv], ["FAKE_CLI_UPLOAD", saved.upload], ["VIBREAD_LAN_PAIRING", saved.pairing]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists only the known Arduino / USB-serial ports", async () => {
    const response = await fetch(`${base}/api/bench/ports`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ports: [{ port: "COM3", label: "COM3 · CH340 (common clone)", vid: 0x1a86, pid: 0x7523 }] });
  });

  it("refuses requests that did not come from this computer", async () => {
    const remote = { "x-forwarded-for": "192.168.1.40" };
    const ports = await fetch(`${base}/api/bench/ports`, { headers: remote });
    expect(ports.status).toBe(403);
    expect(await ports.json()).toMatchObject({ error: { code: "lan_loopback_required" } });
    const flashed = await flash({ port: "COM3", which: "bench" }, remote);
    expect(flashed.status).toBe(403);
    expect(argvLog()).toEqual([]);
  });

  it("uploads the revision's bench HEX to a listed port and logs the uploader's lines", async () => {
    const response = await flash({ port: "COM3", which: "bench" });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; output: string; fqbn: string };
    expect(body).toMatchObject({ ok: true, fqbn: BOARD_PROFILES[golden.circuit.board.profile].fqbn });
    expect(body.output).toContain(`${HEX.length} bytes of flash written`);
    const upload = argvLog().find((args) => args.includes("upload"))!;
    expect(upload[upload.indexOf("--port") + 1]).toBe("COM3");
    expect(upload.at(-1)).toBe("--verbose");
    const log = running.context.ctx.debug.tail(missionId, 50).join("\n");
    expect(log).toContain("native-flash bench: Using port            : COM3");
    expect(log).toContain("flashed COM3");
  });

  it("uses the bench's bootloader profile override for the FQBN", async () => {
    const response = await flash({ port: "COM3", which: "bench", board: "nano-atmega328p-old-5v" });
    expect(response.status).toBe(200);
    const upload = argvLog().find((args) => args.includes("upload"))!;
    expect(upload[upload.indexOf("--fqbn") + 1]).toBe("arduino:avr:nano:cpu=atmega328old");
  });

  it("rejects a port that is not listed, before running the uploader", async () => {
    for (const port of ["COM7", "COM3; del *", "../COM3"]) {
      const response = await flash({ port, which: "bench" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "port_not_listed" } });
    }
    expect(argvLog().some((args) => args.includes("upload"))).toBe(false);
  });

  it.each([
    ["busy", "port_busy"],
    ["sync", "not_in_sync"],
  ])("classifies an upload that fails with %s", async (mode, code) => {
    process.env.FAKE_CLI_UPLOAD = mode;
    const response = await flash({ port: "COM3", which: "bench" });
    expect(response.status).toBe(502);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string }; output: string };
    expect(body).toMatchObject({ ok: false, error: { code } });
    expect(body.output).toContain("Using port");
  });
});
