import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN } from "@vibread/fixtures";
import type { Actor, ConsoleReport, MissionStore } from "@vibread/core";
import type { Pipeline } from "@vibread/tools";
import express from "express";
import pino from "pino";
import type { ContentBuilder } from "spectrum-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../agents/index.js";
import { mockModels, scriptedDesign, scriptedJson, type ScriptStep } from "../agents/testing.js";
import { loadConfig } from "../config.js";
import { createAppContext, type AppContext, type AppContextHandle } from "../context.js";
import { createApiErrorHandler } from "../main.js";
import { mountApi } from "../routes.js";
import {
  alreadyAnsweredText,
  approvalOutcome,
  benchAskOptionTitle,
  benchAskValueForOption,
  capcomLinkUrl,
  capcomMissionLink,
  cloudSendDelayMs,
  faultAlertText,
  isSelectedPollOption,
  isSupportedInboundContentType,
  missionSelection,
  pendingApprovalIndex,
  pollTitleForApproval,
  runCapcom,
  shouldSendApprovalPoll,
  type CapcomSpace,
  type CapcomTransport,
  type InboundMessage,
  type RunningCapcom,
} from "./index.js";
import { answerForChoice, benchNotice, designNotice } from "./notices.js";
import { DEFAULT_CAPCOM_PREFS, inQuietHours, mergeCapcomPrefs } from "./prefs.js";

describe("CAPCOM helpers", () => {
  it("does not duplicate the Houston prefix from bench diagnoses", () => {
    const summary = "Houston, we have a problem: LED1 blinked as light 2 — check the LED jumpers.";

    expect(faultAlertText(summary)).toBe(summary);
    expect(faultAlertText("LED1 blinked as light 2 — check the LED jumpers.")).toBe(summary);
  });

  it("spaces cloud bursts", () => {
    expect(cloudSendDelayMs(0)).toBe(750);
    expect(cloudSendDelayMs(500)).toBe(250);
    expect(cloudSendDelayMs(750)).toBe(0);
    expect(cloudSendDelayMs(1_000)).toBe(0);
  });

  it("binds poll votes to the selected approval instead of FIFO", () => {
    const first = { id: "approval-one", missionId: "mission", actionClass: "physical" as const, summary: "Flash", consequence: "Runs at bench" };
    const second = { id: "approval-two", missionId: "mission", actionClass: "physical" as const, summary: "Self-test", consequence: "Runs at bench" };
    const queue = [
      { notice: first, pollTitle: pollTitleForApproval(first) },
      { notice: second, pollTitle: pollTitleForApproval(second) },
    ];

    expect(pendingApprovalIndex(queue, pollTitleForApproval(second))).toBe(1);
    expect(pendingApprovalIndex(queue)).toBe(0);
  });

  it("distinguishes mission listing and attachment commands from briefs", () => {
    expect(missionSelection("mission")).toBeNull();
    expect(missionSelection("mission 2")).toBe(2);
    expect(missionSelection("mission: build a lamp")).toBeUndefined();
  });

  it("maps bench ask choices to poll labels and back", () => {
    const ask = { choices: ["1", "2", "none"] };

    expect(benchAskOptionTitle("none")).toBe("None of them");
    expect(benchAskValueForOption(ask, "None of them")).toBe("none");
    expect(benchAskValueForOption(ask, "2")).toBe("2");
    expect(benchAskValueForOption(ask, "5")).toBeUndefined();
  });

  it("maps a reply to one of Claude's choices by number or text, else keeps the person's own answer", () => {
    const choices = ["Red", "Blue", "Green"];
    expect(answerForChoice(choices, "2")).toBe("Blue");
    expect(answerForChoice(choices, " green ")).toBe("Green");
    expect(answerForChoice(choices, "4")).toBe("4");
    expect(answerForChoice(choices, "warm white please")).toBe("warm white please");
  });

  it("ignores read receipts, poll deselection, and stale approval decisions", () => {
    expect(isSupportedInboundContentType("text")).toBe(true);
    expect(isSupportedInboundContentType("attachment")).toBe(true);
    expect(isSupportedInboundContentType("poll_option")).toBe(true);
    expect(isSupportedInboundContentType("read")).toBe(false);
    expect(isSupportedInboundContentType("reaction")).toBe(false);
    expect(isSelectedPollOption({ selected: false })).toBe(false);
    expect(isSelectedPollOption({ selected: true })).toBe(true);
    expect(approvalOutcome("approved", "approve-once", "approve-once")).toBe("approved");
    expect(approvalOutcome("denied", "deny", "approve-once")).toBe("decided");
    expect(approvalOutcome("expired", "approve-once", "approve-once")).toBe("expired");
  });

  it("builds phone-reachable CAPCOM links from phoneUrl", () => {
    expect(capcomLinkUrl("http://192.168.1.24:8787/")).toBe("http://192.168.1.24:8787/");
    expect(capcomLinkUrl("https://vibread.example", "pair-token/")).toBe("https://vibread.example/?pair=pair-token%2F");
    expect(capcomMissionLink("http://192.168.1.24:8787/", "mission/1", "pair-token")).toBe("http://192.168.1.24:8787/b/mission%2F1?pair=pair-token");
  });

  it("polls only physical approvals", () => {
    expect(shouldSendApprovalPoll("physical")).toBe(true);
    expect(shouldSendApprovalPoll("state-changing")).toBe(false);
  });

  it("says where a question was already answered", () => {
    expect(alreadyAnsweredText({ kind: "human", id: "u", channel: "web" })).toBe("Already answered on the laptop.");
    expect(alreadyAnsweredText({ kind: "human", id: "u", channel: "imessage" })).toBe("That question was already answered.");
  });
});

describe("CAPCOM quiet hours", () => {
  const quiet = { enabled: true, start: "23:00", end: "07:00", timeZone: "America/Chicago" };

  it("reads the window in the user's time zone, wrapping midnight, and never when off", () => {
    // 04:30 UTC = 23:30 in Chicago (CDT): quiet there, although the server's UTC hour is 4.
    expect(inQuietHours(quiet, new Date("2026-09-27T04:30:00Z"))).toBe(true);
    expect(inQuietHours(quiet, new Date("2026-09-27T11:59:00Z"))).toBe(true); // 06:59 CDT
    expect(inQuietHours(quiet, new Date("2026-09-27T12:00:00Z"))).toBe(false); // 07:00 CDT
    expect(inQuietHours(quiet, new Date("2026-09-27T03:59:00Z"))).toBe(false); // 22:59 CDT
    expect(inQuietHours({ ...quiet, enabled: false }, new Date("2026-09-27T04:30:00Z"))).toBe(false);
    expect(inQuietHours({ ...quiet, start: "09:00", end: "17:00" }, new Date("2026-09-27T15:00:00Z"))).toBe(true); // 10:00 CDT
  });

  it("is off by default and rejects unknown zones and malformed times", () => {
    expect(DEFAULT_CAPCOM_PREFS.quietHours.enabled).toBe(false);
    expect(mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { quietHours: { enabled: true, timeZone: "Europe/Paris" } }).quietHours).toMatchObject({ enabled: true, timeZone: "Europe/Paris", start: "23:00" });
    expect(() => mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { quietHours: { timeZone: "Mars/Olympus" } })).toThrow(/time zone/);
    expect(() => mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { quietHours: { start: "25:00" } })).toThrow(/HH:MM/);
    expect(() => mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { questions: "yes" })).toThrow(/true or false/);
  });
});

describe("CAPCOM notice texts", () => {
  const report = (console: ConsoleReport["console"], verdict: ConsoleReport["verdict"], summary = "ok", findings: ConsoleReport["findings"] = []): ConsoleReport => ({ console, verdict, summary, findings, revisionHash: "h", at: "" });

  it("reads a design's verdicts: ready, NO-GO, a ViBread limit, or nothing while a console is pending", () => {
    const allGo = (["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"] as const).map((c) => report(c, "GO"));
    expect(designNotice("Launch Control", { n: 2, results: { reports: allGo, artifacts: {} } })?.text).toBe(
      "Launch Control r2 is ready — EECOM GO · GUIDO GO · FIDO GO · FAO GO · RETRO GO. Reply GO to start building.",
    );
    const nogo = [report("EECOM", "GO"), report("FIDO", "NO-GO", "2 of 5 scenarios fail: the button never lights LED2."), report("RETRO", "PENDING")];
    expect(designNotice("Launch Control", { n: 3, results: { reports: nogo, artifacts: {} } })?.text).toBe("Launch Control r3: NO-GO from FIDO — 2 of 5 scenarios fail: the button never lights LED2.");
    const noFit = [report("FAO", "NO-GO", "Doesn't fit", [{ console: "FAO", ruleId: "LAYOUT-NO-FIT", severity: "error", title: "ViBread could not lay this circuit out on the breadboard.", fix: "A bigger breadboard will fit.", toolSide: true }])];
    expect(designNotice("Lamp", { n: 1, results: { reports: noFit, artifacts: {} } })?.text).toBe("Lamp r1 stopped on a ViBread limit (LAYOUT-NO-FIT): ViBread could not lay this circuit out on the breadboard. A bigger breadboard will fit.");
    expect(designNotice("Lamp", { n: 1, results: { reports: [report("EECOM", "GO"), report("RETRO", "PENDING")], artifacts: {} } })).toBeUndefined();
  });

  it("reads bench runs: a self-test pass count, a failure's top suspect, nothing for practice runs", () => {
    const results = [
      { test: "led.sequence", status: "pass", subjects: [], summary: "" },
      { test: "button", status: "fail", subjects: [], summary: "" },
      { test: "buzzer", status: "skipped", subjects: [], summary: "" },
    ] as never;
    const diagnosis = { attribution: "wiring" as const, summary: "D2 reads LOW with the button released.", candidates: [{ cause: "button-leg-in-gnd-row", title: "Button leg in the GND row", likelihood: 0.8, highlight: { holes: [], parts: [], jumpers: [] }, fix: "Move the button one row up." }] };
    expect(benchNotice("Lamp", { runId: "run-1", kind: "selftest", verdict: "pass", results, diagnosis })?.text).toBe("Lamp: bench self-test passed — 1/2 checks.");
    expect(benchNotice("Lamp", { runId: "run-2", kind: "selftest", verdict: "fail", results, diagnosis })?.text).toBe(
      "Lamp: Houston, we have a problem: D2 reads LOW with the button released.\nMost likely: Button leg in the GND row — Move the button one row up.",
    );
    expect(benchNotice("Lamp", { runId: "virtual-3", kind: "selftest", verdict: "fail", results, diagnosis })).toBeUndefined();
  });
});

// ---------- end to end: a real server context, a scripted design agent and a fake iMessage transport ----------

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OWNER = "operator";
const WEB: Actor = { kind: "human", id: OWNER, name: "Operator", channel: "web" };
const HANDLE = "+15555550123";
const SPACE = "chat-barry";
const GO_VOTE = { verdict: "GO", summary: "The lamp does what the brief asks.", reasons: ["Debounced button"], concerns: [] };
const ASK: ScriptStep = { text: "One question first.", toolCalls: [{ name: "ask_user", id: "toolu_ask", input: { question: "Which color should the lamp glow?", choices: ["Red", "Blue", "Green"] } }] };
const PROPOSE: ScriptStep = { toolCalls: [{ name: "propose_design", input: { circuit: golden.circuit, note: "First design" } }] };

type Sent = { spaceId: string; content: Record<string, unknown> };

function fakeTransport() {
  const sent: Sent[] = [];
  const inbox: [CapcomSpace, InboundMessage][] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const space = (id: string): CapcomSpace => ({
    id,
    async send(content: ContentBuilder) {
      sent.push({ spaceId: id, content: (await content.build()) as unknown as Record<string, unknown> });
    },
  });
  const transport: CapcomTransport = {
    provider: "test",
    polls: true,
    effects: false,
    paced: false,
    messages: {
      async *[Symbol.asyncIterator]() {
        while (!stopped) {
          const next = inbox.shift();
          if (next) yield next;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
    space: async (id) => space(id),
    async stop() {
      stopped = true;
      wake?.();
    },
  };
  const receive = (content: Record<string, unknown>) => {
    inbox.push([space(SPACE), { sender: { id: HANDLE }, content }]);
    wake?.();
  };
  const texts = () => sent.flatMap((s) => (s.content.type === "text" ? [String(s.content.text)] : []));
  return { transport, sent, texts, receive };
}

/** Deterministic stand-in for the engine pipeline: every deterministic console votes `verdict`. */
function pipelineVoting(store: MissionStore, verdict: "GO" | "NO-GO"): Pipeline {
  return {
    async evaluate(missionId, n) {
      const revision = (await store.getRevision(missionId, n))!;
      const reports: ConsoleReport[] = (["EECOM", "GUIDO", "FIDO", "FAO"] as const).map((console) => ({
        console,
        verdict: console === "FIDO" ? verdict : "GO",
        summary: console === "FIDO" && verdict === "NO-GO" ? "2 of 5 scenarios fail: the button never lights LED2." : "ok",
        findings: console === "FIDO" && verdict === "NO-GO" ? [{ console: "FIDO", ruleId: "SIM-FAIL", severity: "error", title: "Scenario fails" }] : [],
        revisionHash: revision.hash,
        at: new Date().toISOString(),
      }));
      return (await store.saveResults(missionId, n, { reports })).results;
    },
  };
}

const handles: AppContextHandle[] = [];
const bots: RunningCapcom[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const handle of handles.splice(0)) handle.close();
});

async function harness(options: { script?: ScriptStep[]; verdict?: "GO" | "NO-GO"; link?: boolean; now?: () => Date } = {}) {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), "vb-capcom-")),
    PORT: "8896",
    HOST: "127.0.0.1",
    BETTER_AUTH_SECRET: "capcom-test-auth-secret-0000000000000000000",
    VIBREAD_APPROVAL_SECRET: "capcom-test-approval-secret-00000000000000",
    CAPCOM_PROVIDER: "off",
  });
  const handle = createAppContext({ config, log: pino({ level: "silent" }) });
  handles.push(handle);
  const ctx: AppContext = handle.ctx;
  await ctx.operator();
  const fast = scriptedJson((context) => (JSON.stringify(context.messages).includes("RETRO") ? GO_VOTE : golden.suite));
  const runtime = createAgentRuntime({
    config: ctx.config,
    log: ctx.log,
    store: ctx.store,
    broker: ctx.broker,
    machine: ctx.machine,
    messages: ctx.messages,
    claudeAccounts: ctx.claudeAccounts,
    inventory: ctx.inventory,
    hardware: ctx.hardware,
    debug: ctx.debug,
    models: mockModels(scriptedDesign(options.script ?? []), fast),
    pipeline: pipelineVoting(ctx.store, options.verdict ?? "GO"),
  });
  ctx.runtime = runtime;
  ctx.missions = runtime.missions;
  if (options.link !== false) {
    const { code } = await ctx.links.createCode(OWNER);
    await ctx.links.redeem(code, HANDLE);
    await ctx.capcomSpaces.put({ spaceId: SPACE, handle: HANDLE, userId: OWNER });
  }
  const fake = fakeTransport();
  const bot = runCapcom(ctx, fake.transport, options.now ? { now: options.now } : {});
  bots.push(bot);
  const mission = await ctx.missions.create({ brief: golden.brief, inventory: golden.inventory, owner: WEB, title: "Launch Control" });
  return { ctx, bot, mission, ...fake };
}

const pick = (title: string) => ({ type: "poll_option", selected: true, option: { title }, poll: { title: "Which color should the lamp glow?" } });

describe("CAPCOM delivery (end to end)", () => {
  it("sends a web-created mission's question to the linked phone as text + poll; a pick answers it, a second pick is already answered", async () => {
    const { ctx, bot, mission, sent, texts, receive } = await harness({ script: [ASK, { text: "Blue it is — designing now." }] });

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();

    expect(sent.every((s) => s.spaceId === SPACE)).toBe(true);
    expect(texts()[0]).toBe("Claude has a question about Launch Control: Which color should the lamp glow?\n(about Launch Control; reply `mission` to switch)");
    expect(sent[1]?.content).toMatchObject({ type: "poll", title: "Which color should the lamp glow?", options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }] });
    expect(texts()[1]).toBe("Pick one, or reply with your own answer.");
    expect(sent).toHaveLength(3);

    receive(pick("Blue"));
    await vi.waitFor(() => expect(texts()).toContain("Blue it is — designing now."), { timeout: 5_000 });
    // Answered through the same path as the web card: a chat message from the owner on iMessage.
    const history = await ctx.messages.list(mission.id);
    expect(history.filter((m) => m.role === "user").map((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""))).toEqual([golden.brief, "Blue"]);
    const answered = (await ctx.store.listEvents(mission.id)).filter((e) => e.kind === "agent.ask.answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toMatchObject({ askId: "toolu_ask", by: { channel: "imessage", id: OWNER } });

    receive(pick("Red"));
    await vi.waitFor(() => expect(texts().at(-1)).toBe("That question was already answered."), { timeout: 5_000 });
    expect((await ctx.messages.list(mission.id)).filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("tells a late poll pick that the laptop answered first", async () => {
    const { ctx, bot, mission, texts, receive } = await harness({ script: [ASK, { text: "Green it is." }] });
    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();

    await ctx.missions.say(mission.id, "Green", WEB);
    receive(pick("Blue"));
    await vi.waitFor(() => expect(texts().at(-1)).toBe("Already answered on the laptop."), { timeout: 5_000 });
    expect((await ctx.messages.list(mission.id)).filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("a plain text reply answers the open question by choice number", async () => {
    const { ctx, bot, mission, texts, receive } = await harness({ script: [ASK, { text: "Green it is." }] });
    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();

    receive({ type: "text", text: "3" });
    await vi.waitFor(() => expect(texts()).toContain("Green it is."), { timeout: 5_000 });
    const history = await ctx.messages.list(mission.id);
    expect(history.findLast((m) => m.role === "user")?.parts).toEqual([{ type: "text", text: "Green" }]);
  });

  it("sends 'design ready' once, with the verdicts and a mission link", async () => {
    const { ctx, bot, mission, texts } = await harness({ script: [PROPOSE, { text: "Revision 1 is ready." }, { text: "Nothing else changed." }] });

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();
    await ctx.missions.say(mission.id, "Anything else?", WEB);
    await bot.idle();

    const ready = texts().filter((t) => t.includes("is ready"));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toBe(
      `Launch Control r1 is ready — EECOM GO · GUIDO GO · FIDO GO · FAO GO · RETRO GO. Reply GO to start building.\n${capcomMissionLink(ctx.config.phoneUrl, mission.id, ctx.lanGuard.pairToken())}\n(about Launch Control; reply \`mission\` to switch)`,
    );
    // A quick plain answer (under 20 s) is not echoed.
    expect(texts()).toHaveLength(1);
  });

  it("sends a NO-GO once, with the console and its summary", async () => {
    const { ctx, bot, mission, texts } = await harness({ script: [PROPOSE, { text: "FIDO says no." }], verdict: "NO-GO" });

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();

    const nogo = texts().filter((t) => t.includes("NO-GO"));
    expect(nogo).toHaveLength(1);
    expect(nogo[0]?.startsWith("Launch Control r1: NO-GO from FIDO — 2 of 5 scenarios fail: the button never lights LED2.\n")).toBe(true);
  });

  it("holds notifications during the owner's quiet hours and sends one digest after; replies are never held", async () => {
    let now = new Date("2026-09-27T05:00:00Z"); // 00:00 in Chicago
    const { ctx, bot, mission, texts, receive } = await harness({ script: [PROPOSE, { text: "Ready." }], now: () => now });
    ctx.capcom.prefs.save(OWNER, mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { quietHours: { enabled: true, start: "23:00", end: "07:00", timeZone: "America/Chicago" } }));

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();
    expect(texts()).toEqual([]);
    expect(ctx.capcom.prefs.queuedUsers()).toEqual([OWNER]);

    receive({ type: "text", text: "mission" });
    await vi.waitFor(() => expect(texts()[0]).toBe("Your missions:\n1. Launch Control — GONOGO\nReply `mission <number>` to attach."), { timeout: 5_000 });

    await bot.flushDigests();
    expect(texts()).toHaveLength(1);

    now = new Date("2026-09-27T12:30:00Z"); // 07:30 in Chicago
    await bot.flushDigests();
    expect(texts()[1]).toBe(
      "While you were in quiet hours:\n• Launch Control r1 is ready — EECOM GO · GUIDO GO · FIDO GO · FAO GO · RETRO GO. Reply GO to start building.\n(about Launch Control; reply `mission` to switch)",
    );
    expect(ctx.capcom.prefs.queuedUsers()).toEqual([]);
  });

  it("respects a switched-off category", async () => {
    const { ctx, bot, mission, sent } = await harness({ script: [ASK] });
    ctx.capcom.prefs.save(OWNER, mergeCapcomPrefs(DEFAULT_CAPCOM_PREFS, { questions: false }));

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();
    expect(sent).toEqual([]);
  });

  it("sends nothing to an owner who never linked a phone", async () => {
    const { ctx, bot, mission, sent } = await harness({ script: [ASK], link: false });

    await ctx.missions.say(mission.id, golden.brief, WEB);
    await bot.idle();
    expect(sent).toEqual([]);
  });
});

describe("POST /api/connections/imessage/test", () => {
  async function serve(ctx: AppContext): Promise<string> {
    const app = express();
    app.use(express.json());
    mountApi(app, ctx);
    app.use(createApiErrorHandler(ctx.log));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections/imessage`;
  }

  it("texts the linked conversation and reports ok", async () => {
    const { ctx, sent } = await harness();
    const response = await fetch(`${await serve(ctx)}/test`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toEqual([{ spaceId: SPACE, content: { type: "text", text: "ViBread test — notifications work" } }]);
  });

  it("returns the real reason when nothing is linked, or when CAPCOM is off", async () => {
    const { ctx, bot } = await harness({ link: false });
    const base = await serve(ctx);
    const unlinked = await fetch(`${base}/test`, { method: "POST" });
    expect(unlinked.status).toBe(409);
    expect(((await unlinked.json()) as { error: { message: string } }).error.message).toMatch(/No iMessage conversation is linked/);

    await bot.stop();
    const off = await fetch(`${base}/test`, { method: "POST" });
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: { message: string } }).error.message).toBe(
      "CAPCOM is off on this server. Set CAPCOM_PROVIDER=cloud, PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, CAPCOM_NUMBER (or save the Photon settings below).",
    );
    const settings = (await (await fetch(`${base}/settings`)).json()) as { provider: string; running: boolean; linked: boolean; prefs: { questions: boolean } };
    expect(settings).toMatchObject({ provider: "off", running: false, linked: false, prefs: { questions: true, designs: true, bench: true } });
  });
});
