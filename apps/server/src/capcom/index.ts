import type { Database as SqliteDatabase } from "better-sqlite3";
import { heifToJpeg } from "heif2jpeg";
import {
  Spectrum,
  app as appCard,
  attachment,
  option,
  poll,
  text,
  type ContentBuilder,
  type Message,
  type Space,
} from "spectrum-ts";
import { effect, imessage, nativeContactCard } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import type { Actor, AgentTurnResult, ApprovalRequest, BenchRunResult, Mission, PhotoPartAnswer, TimelineEvent } from "@vibread/core";
import type { Logger } from "pino";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { AGENT_ASKED, AGENT_RUN_FINISHED, type OpenAsk, type RunFinishedData } from "../agents/runs.js";
import type { BenchAsk } from "../services/bench-asks.js";
import { answerForChoice, benchNotice, clip, designNotice, digestText, faultAlertText, questionText } from "./notices.js";
import { createCapcomPrefStore, inQuietHours, type CapcomCategory, type CapcomPrefStore } from "./prefs.js";

export { faultAlertText } from "./notices.js";

// ---------- transport ----------

/** The parts of a Spectrum Space CAPCOM uses (a test transport implements just these). */
export interface CapcomSpace {
  readonly id: string;
  send(content: ContentBuilder): Promise<unknown>;
  responding?(fn: () => Promise<void>): Promise<void>;
}

export interface InboundMessage {
  readonly sender?: { readonly id: string };
  readonly content: unknown;
}

/** Spectrum (Photon iMessage cloud or the local terminal chat), or a fake in tests. */
export interface CapcomTransport {
  readonly provider: "cloud" | "terminal" | "test";
  /** Native polls and message effects exist (iMessage); elsewhere choices are numbered text. */
  readonly polls: boolean;
  readonly effects: boolean;
  /** Space cloud sends out (Photon rate limits bursts). */
  readonly paced: boolean;
  readonly messages: AsyncIterable<[CapcomSpace, InboundMessage]>;
  space(spaceId: string): Promise<CapcomSpace>;
  stop(): Promise<void>;
}

interface SpaceProvider {
  readonly space: { get(spaceId: string): Promise<Space> };
}

async function spectrumTransport(provider: "cloud" | "terminal", photon?: { projectId: string; projectSecret: string }): Promise<CapcomTransport> {
  const spectrum = provider === "terminal" ? await Spectrum({ providers: [terminal.config()] }) : await Spectrum({ ...photon!, providers: [imessage.config()] });
  const app = spectrum as unknown as { messages: AsyncIterable<[Space, Message]>; stop(): Promise<void> };
  const factory = provider === "terminal" ? terminal : imessage;
  const spaces = (factory as unknown as (instance: unknown) => SpaceProvider)(spectrum);
  const cloud = provider === "cloud";
  return {
    provider,
    polls: cloud,
    effects: cloud,
    paced: cloud,
    messages: app.messages as unknown as AsyncIterable<[CapcomSpace, InboundMessage]>,
    space: (spaceId) => spaces.space.get(spaceId) as Promise<CapcomSpace>,
    stop: () => app.stop(),
  };
}

// ---------- pure helpers (unit-tested) ----------

interface ApprovalNotice {
  id: string;
  missionId: string;
  actionClass: ApprovalRequest["actionClass"];
  summary: string;
  consequence: string;
}

interface PendingApproval {
  notice: ApprovalNotice;
  pollTitle: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentText(content: Record<string, unknown>): string {
  const type = stringValue(content.type);
  if (type === "text" && typeof content.text === "string") return content.text;
  if (type === "markdown" && typeof content.markdown === "string") return content.markdown;
  if (type === "reply") {
    const inner = asRecord(content.content);
    if (inner && typeof inner.text === "string") return inner.text;
    if (inner && typeof inner.markdown === "string") return inner.markdown;
  }
  return "";
}

export function isSupportedInboundContentType(type: string | undefined): boolean {
  return type === "text" || type === "attachment" || type === "poll_option";
}

export function isSelectedPollOption(content: Record<string, unknown>): boolean {
  return content.selected !== false;
}

export function approvalOutcome(
  status: "pending" | "approved" | "denied" | "expired" | "consumed",
  decision: "approve-once" | "approve-mission" | "deny" | undefined,
  requested: "approve-once" | "deny",
): "approved" | "denied" | "expired" | "decided" {
  if ((status === "approved" || status === "consumed") && decision === requested) return "approved";
  if (status === "denied" && decision === requested) return "denied";
  if (status === "expired") return "expired";
  return "decided";
}

export function capcomLinkUrl(phoneUrl: string, pairToken?: string): string {
  const base = `${phoneUrl.replace(/\/$/, "")}/`;
  if (!pairToken) return base;
  return `${base}?pair=${encodeURIComponent(pairToken)}`;
}

export function capcomMissionLink(phoneUrl: string, missionId: string, pairToken?: string): string {
  const base = `${phoneUrl.replace(/\/$/, "")}/b/${encodeURIComponent(missionId)}`;
  if (!pairToken) return base;
  return `${base}?pair=${encodeURIComponent(pairToken)}`;
}

function normalizedVote(value: string): "approve-once" | "deny" | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "go" || normalized === "yes" || normalized === "approve" || normalized === "approve-once") return "approve-once";
  if (normalized === "no-go" || normalized === "nogo" || normalized === "no" || normalized === "deny") return "deny";
  return undefined;
}

function linkCodeFrom(textValue: string): string | undefined {
  const match = /^(?:link(?:ing)?(?:\s+code)?[:\s]+)?([A-Z0-9-]{6,})$/i.exec(textValue.trim());
  return match?.[1];
}

export function missionSelection(value: string): number | null | undefined {
  const match = /^mission(?:\s+(\d+))?$/i.exec(value.trim());
  if (!match) return undefined;
  return match[1] ? Number(match[1]) : null;
}

function missionBriefFrom(textValue: string): string | undefined {
  const match = /^(?:brief|mission)\s*[:\-]?\s+(.+)$/is.exec(textValue.trim());
  return match?.[1]?.trim();
}

function missionIdFromEvent(event: TimelineEvent): string | undefined {
  if (event.missionId) return event.missionId;
  const data = asRecord(event.data);
  return stringValue(data?.missionId);
}

function approvalFromEvent(event: TimelineEvent): ApprovalNotice | undefined {
  const data = asRecord(event.data);
  const nested = asRecord(data?.approval) ?? asRecord(data?.request) ?? data;
  if (!nested) return undefined;
  const id = stringValue(nested.id);
  const missionId = stringValue(nested.missionId) ?? event.missionId;
  const actionClass = nested.actionClass;
  if (!id || !missionId || (actionClass !== "physical" && actionClass !== "read-only" && actionClass !== "state-changing" && actionClass !== "bom-change")) return undefined;
  return {
    id,
    missionId,
    actionClass,
    summary: stringValue(nested.summary) ?? "Approval requested",
    consequence: stringValue(nested.consequence) ?? "This action changes the mission.",
  };
}

export function shouldSendApprovalPoll(actionClass: ApprovalRequest["actionClass"]): boolean {
  return actionClass === "physical";
}

function benchAskFromEvent(event: TimelineEvent): BenchAsk | undefined {
  const data = asRecord(event.data);
  const raw = asRecord(data?.ask) ?? data;
  if (!raw) return undefined;
  const missionId = stringValue(raw.missionId) ?? event.missionId;
  const askId = stringValue(raw.askId) ?? stringValue(raw.id);
  const prompt = stringValue(raw.prompt) ?? stringValue(raw.title);
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((choice): choice is string => typeof choice === "string" && choice.length > 0) : [];
  if (!missionId || !askId || !prompt || choices.length === 0) return undefined;
  const statusValue = stringValue(raw.status);
  const status: BenchAsk["status"] = statusValue === "answered" || statusValue === "closed" ? statusValue : "open";
  return {
    missionId,
    askId,
    test: stringValue(raw.test) ?? "bench",
    kind: stringValue(raw.kind) ?? "question",
    ...(stringValue(raw.part) ? { part: stringValue(raw.part) } : {}),
    prompt,
    choices,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : Date.now() + 20_000,
    status,
  };
}

export function benchAskOptionTitle(choice: string): string {
  return choice.trim().toLowerCase() === "none" ? "None of them" : choice;
}

export function benchAskValueForOption(ask: Pick<BenchAsk, "choices">, optionTitle: string): string | undefined {
  const normalized = optionTitle.trim().toLowerCase();
  return ask.choices.find((choice) => choice.trim().toLowerCase() === normalized || benchAskOptionTitle(choice).toLowerCase() === normalized);
}

export function pollTitleForApproval(notice: ApprovalNotice): string {
  return `Mission approval #${notice.id.slice(0, 8)}: ${notice.summary}`;
}

export function pendingApprovalIndex(queue: readonly PendingApproval[], pollTitle?: string): number {
  if (!pollTitle) return queue.length > 0 ? 0 : -1;
  return queue.findIndex((pending) => pending.pollTitle === pollTitle);
}

function isLaunchEvent(event: TimelineEvent): boolean {
  if (event.kind === "mission.launched" || event.kind === "launch" || event.kind === "launched") return true;
  const data = asRecord(event.data);
  return (event.kind === "phase.changed" && data?.to === "LAUNCH") || data?.type === "LAUNCHED";
}

export function cloudSendDelayMs(elapsed: number): number {
  return Math.max(0, 750 - elapsed);
}

/** Who already answered a question, as the phone reads it. */
export function alreadyAnsweredText(by: Actor | undefined): string {
  if (by?.channel === "web") return "Already answered on the laptop.";
  if (by?.channel === "imessage") return "That question was already answered.";
  if (by?.channel === "mcp") return "Already answered from Claude Code.";
  return "That question was already answered.";
}

/** A run that ends with a plain answer is announced only when it took longer than this. */
const LONG_RUN_MS = 20_000;
const DIGEST_INTERVAL_MS = 60_000;
const TEST_MESSAGE = "ViBread test — notifications work";

export class CapcomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapcomError";
  }
}

// ---------- the running bot ----------

export interface RunningCapcom {
  readonly provider: CapcomTransport["provider"];
  /** Sends the test message to the user's linked conversation; throws the real error. */
  sendTest(userId: string): Promise<void>;
  /** Delivers held notifications of users whose quiet hours are over (also runs every minute). */
  flushDigests(): Promise<void>;
  /** Resolves once every timeline event received so far has been handled (tests). */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

interface Target {
  space: CapcomSpace;
  spaceId: string;
  handle: string;
  missionId?: string;
}

interface Notice {
  missionId: string;
  category: CapcomCategory;
  /** Dedupe key within the mission: each notice is sent (or queued) once. */
  key: string;
  text: string;
  link?: boolean;
  ask?: OpenAsk;
  celebrate?: boolean;
}

/** CAPCOM's message loop and notifications over `transport`; registers itself on ctx.capcom until stopped. */
export function runCapcom(ctx: AppContext, transport: CapcomTransport, options: { now?: () => Date } = {}): RunningCapcom {
  const now = options.now ?? (() => new Date());
  const prefs = ctx.capcom.prefs;
  const spaceCache = new Map<string, CapcomSpace>();
  const activeMissions = new Map<string, string>();
  const awaitingFirstReply = new Set<string>();
  const pendingApprovalsBySpace = new Map<string, PendingApproval[]>();
  const openBenchAskBySpace = new Map<string, { ask: BenchAsk; pollTitle: string }>();
  const closedBenchPollsBySpace = new Map<string, Set<string>>();
  const closedBenchChoicesBySpace = new Map<string, Set<string>>();
  /** Poll title → Claude's question it carries, per conversation (kept after answering to say "already answered"). */
  const askPollsBySpace = new Map<string, Map<string, { missionId: string; askId: string; choices: string[] }>>();
  const sent = new Set<string>();
  let lastSentAt = 0;
  let stopping = false;
  let pending: Promise<void> = Promise.resolve();

  const remember = (key: string): void => {
    sent.add(key);
    if (sent.size > 5_000) sent.delete(sent.values().next().value!);
  };

  /** Sends one message; throws the provider's error. */
  const deliver = async (space: CapcomSpace, content: ContentBuilder): Promise<void> => {
    if (transport.paced) {
      const delay = cloudSendDelayMs(Date.now() - lastSentAt);
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    if (space.responding) {
      await space.responding(async () => {
        await space.send(content);
      });
    } else {
      await space.send(content);
    }
    lastSentAt = Date.now();
  };

  const send = async (space: CapcomSpace, content: ContentBuilder): Promise<boolean> => {
    try {
      await deliver(space, content);
      return true;
    } catch (error) {
      ctx.log.warn({ err: error, spaceId: space.id }, "CAPCOM send failed");
      return false;
    }
  };

  const sendText = (space: CapcomSpace, value: string): Promise<boolean> => send(space, text(value));

  const missionLink = (missionId: string): string => capcomMissionLink(ctx.config.phoneUrl, missionId, ctx.lanGuard.pairToken());

  /** The linked user's conversation (their newest persisted binding for the handle they linked). */
  const targetForUser = async (userId: string): Promise<Target | undefined> => {
    const handle = await ctx.links.handleForUser(userId);
    if (!handle) return undefined;
    const binding = (await ctx.capcomSpaces.listAll()).find((b) => b.userId === userId && b.handle === handle);
    if (!binding) return undefined;
    let space = spaceCache.get(binding.spaceId);
    if (!space) {
      space = await transport.space(binding.spaceId);
      spaceCache.set(binding.spaceId, space);
    }
    return { space, spaceId: binding.spaceId, handle, ...(binding.missionId ? { missionId: binding.missionId } : {}) };
  };

  const attachMission = async (spaceId: string, handle: string, missionId: string): Promise<void> => {
    activeMissions.set(handle, missionId);
    try {
      await ctx.capcomSpaces.setMission(spaceId, missionId);
    } catch (error) {
      ctx.log.warn({ err: error, spaceId, missionId }, "CAPCOM mission attachment failed");
    }
  };

  const activeMission = async (handle: string, spaceId: string): Promise<string | undefined> => {
    const active = activeMissions.get(handle);
    if (active) return active;
    const binding = await ctx.capcomSpaces.get(spaceId);
    if (binding?.missionId) activeMissions.set(handle, binding.missionId);
    return binding?.missionId ?? undefined;
  };

  /** Makes the notice's mission the handle's active one (replies go there); says so when that changed. */
  const focus = async (target: Target, mission: Pick<Mission, "id" | "title">): Promise<string> => {
    const current = activeMissions.get(target.handle) ?? target.missionId;
    if (current === mission.id) {
      activeMissions.set(target.handle, mission.id);
      return "";
    }
    await attachMission(target.spaceId, target.handle, mission.id);
    target.missionId = mission.id;
    return `\n(about ${mission.title}; reply \`mission\` to switch)`;
  };

  /** Question text + a poll of its choices (iMessage) + "or reply with your own answer": three messages at most. */
  const presentAsk = async (target: Target, mission: Mission, ask: OpenAsk, about: string): Promise<void> => {
    const usePoll = transport.polls && ask.choices.length > 0;
    await sendText(target.space, `${questionText(mission.title, ask.question, ask.choices, !usePoll)}${about}`);
    let polled = false;
    if (usePoll) {
      const pollTitle = clip(ask.question, 200);
      const polls = askPollsBySpace.get(target.spaceId) ?? new Map();
      polls.set(pollTitle, { missionId: mission.id, askId: ask.askId, choices: ask.choices });
      askPollsBySpace.set(target.spaceId, polls);
      polled = await send(target.space, poll(pollTitle, ...ask.choices.map((choice) => option(choice))));
    }
    const hint = ask.choices.length === 0
      ? "Reply with your answer."
      : polled
        ? "Pick one, or reply with your own answer."
        : `${usePoll ? `${ask.choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n")}\n` : ""}Reply with a number, or with your own answer.`;
    await sendText(target.space, hint);
  };

  const present = async (target: Target, mission: Mission, notice: Notice): Promise<void> => {
    const about = await focus(target, mission);
    if (notice.ask) {
      await presentAsk(target, mission, notice.ask, about);
      return;
    }
    const body = `${notice.text}${notice.link ? `\n${missionLink(mission.id)}` : ""}${about}`;
    if (notice.celebrate && transport.effects && (await send(target.space, effect(text(body), imessage.effect.message.celebration)))) return;
    await sendText(target.space, body);
  };

  /**
   * One notification for the mission's owner, if they linked a phone and want this category. `reply`: part of an answer to
   * their own message — always sent, never held. Otherwise quiet hours hold it for the digest; nothing is dropped.
   */
  const notify = async (notice: Notice, options: { reply?: boolean } = {}): Promise<void> => {
    const key = `${notice.missionId}:${notice.key}`;
    if (sent.has(key)) return;
    const mission = await ctx.store.getMission(notice.missionId);
    if (!mission) return;
    const target = await targetForUser(mission.ownerId);
    if (!target) return;
    const userPrefs = prefs.get(mission.ownerId);
    if (!options.reply && !userPrefs[notice.category]) return;
    remember(key);
    if (!options.reply && inQuietHours(userPrefs.quietHours, now())) {
      const held = notice.ask
        ? `${mission.title}: Claude asked: ${notice.ask.question}${notice.ask.choices.length ? ` (${notice.ask.choices.join(" / ")})` : ""}`
        : notice.text;
      prefs.enqueue(mission.ownerId, { missionId: mission.id, text: held });
      return;
    }
    await present(target, mission, notice);
  };

  const askNotice = (missionId: string, ask: OpenAsk): Notice => ({ missionId, category: "questions", key: `ask:${ask.askId}`, text: ask.question, ask });

  const designFor = async (missionId: string, n: number, options: { reply?: boolean } = {}): Promise<void> => {
    const [mission, revision] = await Promise.all([ctx.store.getMission(missionId), ctx.store.getRevision(missionId, n)]);
    if (!mission || !revision) return;
    const notice = designNotice(mission.title, revision);
    if (notice) await notify({ missionId, category: "designs", key: notice.key, text: notice.text, link: true }, options);
  };

  const flushDigests = async (): Promise<void> => {
    for (const userId of prefs.queuedUsers()) {
      if (inQuietHours(prefs.get(userId).quietHours, now())) continue;
      const target = await targetForUser(userId);
      if (!target) continue;
      const items = prefs.drain(userId);
      if (items.length === 0) continue;
      const missionIds = [...new Set(items.flatMap((item) => (item.missionId ? [item.missionId] : [])))];
      // Replies go to the newest held question's mission, else the newest notice's.
      let asked: { mission: Mission; ask: OpenAsk } | undefined;
      for (const missionId of [...missionIds].reverse()) {
        const ask = await ctx.runtime.asks.open(missionId);
        const mission = ask ? await ctx.store.getMission(missionId) : null;
        if (ask && mission) {
          asked = { mission, ask };
          break;
        }
      }
      const focusId = asked?.mission.id ?? missionIds.at(-1);
      const focusMission = asked?.mission ?? (focusId ? await ctx.store.getMission(focusId) : null);
      const about = focusMission ? await focus(target, focusMission) : "";
      // A failed send (Photon outage, rate limit) must not lose what quiet hours held: queue it again for the next flush.
      if (!(await sendText(target.space, `${digestText(items)}${about}`))) {
        for (const item of items) prefs.enqueue(userId, { ...(item.missionId ? { missionId: item.missionId } : {}), text: item.text });
        continue;
      }
      if (asked) await presentAsk(target, asked.mission, asked.ask, "");
    }
  };

  // ---------- bench prompts and approvals (for the mission the phone is on) ----------

  const rememberClosedBenchAsk = (spaceId: string, closing: { ask: BenchAsk; pollTitle: string }): void => {
    openBenchAskBySpace.delete(spaceId);
    const closedPolls = closedBenchPollsBySpace.get(spaceId) ?? new Set<string>();
    closedPolls.add(closing.pollTitle);
    closedBenchPollsBySpace.set(spaceId, closedPolls);
    const closedChoices = closedBenchChoicesBySpace.get(spaceId) ?? new Set<string>();
    for (const choice of closing.ask.choices) {
      closedChoices.add(choice.trim().toLowerCase());
      closedChoices.add(benchAskOptionTitle(choice).trim().toLowerCase());
    }
    closedBenchChoicesBySpace.set(spaceId, closedChoices);
  };

  const actorForHandle = async (handle: string): Promise<Actor | undefined> => {
    const userId = await ctx.links.userForHandle(handle);
    return userId ? { kind: "human", id: userId, channel: "imessage" } : undefined;
  };

  const sendApproval = async (space: CapcomSpace, notice: ApprovalNotice): Promise<void> => {
    const queue = pendingApprovalsBySpace.get(space.id) ?? [];
    const pollTitle = pollTitleForApproval(notice);
    queue.push({ notice, pollTitle });
    pendingApprovalsBySpace.set(space.id, queue);
    if (transport.polls) await send(space, poll(pollTitle, option("GO"), option("NO-GO")));
    else await sendText(space, pollTitle);
    await sendText(space, `Reply GO or NO-GO. ${notice.consequence}`);
  };

  const sendBenchAsk = async (space: CapcomSpace, ask: BenchAsk): Promise<void> => {
    if (openBenchAskBySpace.has(space.id)) return;
    const pollTitle = ask.prompt;
    openBenchAskBySpace.set(space.id, { ask, pollTitle });
    if (transport.polls) await send(space, poll(pollTitle, ...ask.choices.map((choice) => option(benchAskOptionTitle(choice)))));
    else await sendText(space, pollTitle);
    await sendText(space, `Reply ${ask.choices.map(benchAskOptionTitle).join(" / ")}.`);
  };

  const answerBenchAsk = async (space: CapcomSpace, handle: string, optionTitle: string, pollTitle?: string): Promise<boolean> => {
    const open = openBenchAskBySpace.get(space.id);
    if (!open) {
      const closed = closedBenchPollsBySpace.get(space.id);
      if (pollTitle && closed?.has(pollTitle)) {
        await sendText(space, "That question already closed.");
        return true;
      }
      const missionId = await activeMission(handle, space.id);
      // Claude's own open question wins: its numbered answers overlap old bench choices ("1", "2", "none").
      if (missionId && (await ctx.runtime.asks.open(missionId))) return false;
      const closedChoices = closedBenchChoicesBySpace.get(space.id);
      if (closedChoices?.has(optionTitle.trim().toLowerCase())) {
        await sendText(space, "That question already closed.");
        return true;
      }
      return false;
    }
    const value = benchAskValueForOption(open.ask, optionTitle);
    if (!value) {
      await sendText(space, `Reply ${open.ask.choices.map(benchAskOptionTitle).join(" / ")}.`);
      return true;
    }
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    let answered = false;
    try {
      answered = ctx.benchAsks.answer(open.ask.missionId, open.ask.askId, value, actor);
    } catch {
      answered = false;
    }
    rememberClosedBenchAsk(space.id, open);
    await sendText(space, answered ? "Answer recorded." : "That question already closed.");
    return true;
  };

  /** The owner's conversation, when that conversation is on this mission (bench prompts and approvals only go there). */
  const benchTarget = async (missionId: string): Promise<Target | undefined> => {
    const mission = await ctx.store.getMission(missionId);
    if (!mission || !prefs.get(mission.ownerId).bench) return undefined;
    const target = await targetForUser(mission.ownerId);
    if (!target) return undefined;
    return (activeMissions.get(target.handle) ?? target.missionId) === missionId ? target : undefined;
  };

  const sendStepImage = async (space: CapcomSpace, missionId: string, step: number): Promise<void> => {
    const mission = await ctx.store.getMission(missionId);
    const n = mission?.releasedRevision ?? mission?.currentRevision;
    const revision = n !== undefined ? await ctx.store.getRevision(missionId, n) : null;
    const hash = revision?.results.artifacts[`step-${step}.png`];
    const artifact = hash ? await ctx.store.getArtifact(hash) : null;
    if (!artifact || !artifact.contentType.toLowerCase().includes("png")) return;
    await send(space, attachment(Buffer.from(artifact.data), { name: `step-${step}.png`, mimeType: "image/png" }));
  };

  // ---------- timeline → notifications ----------

  const handleTimelineEvent = async (event: TimelineEvent): Promise<void> => {
    const missionId = missionIdFromEvent(event);
    if (!missionId) return;
    const data = asRecord(event.data);

    // Runs started from iMessage are answered in the reply itself (text, then the question or design verdict).
    if (event.kind === AGENT_ASKED && event.channel !== "imessage") {
      const ask = data as unknown as OpenAsk | undefined;
      if (ask?.askId && ask.question) await notify(askNotice(missionId, { askId: ask.askId, question: ask.question, choices: Array.isArray(ask.choices) ? ask.choices : [] }));
      return;
    }
    if (event.kind === AGENT_RUN_FINISHED && event.channel !== "imessage") {
      const run = data as unknown as RunFinishedData;
      if (run.outcome === "aborted") return;
      const designed = run.revisionAfter !== undefined && run.revisionAfter !== run.revisionBefore;
      if (designed) await designFor(missionId, run.revisionAfter!);
      const mission = await ctx.store.getMission(missionId);
      if (!mission) return;
      if (run.outcome === "error") {
        await notify({ missionId, category: "designs", key: `run:${run.runId}`, text: `${mission.title}: Claude's run failed — ${run.error ?? "unknown error"}`, link: true });
      } else if (run.outcome === "done" && !designed && run.ms > LONG_RUN_MS && run.text) {
        await notify({ missionId, category: "designs", key: `run:${run.runId}`, text: `${mission.title}: Claude finished: ${clip(run.text, 200)}`, link: true });
      }
      return;
    }
    if (event.kind === "phase.changed") {
      const type = stringValue(asRecord(data?.event)?.type);
      // Designs proposed outside a chat run (Claude Code over MCP); a chat run reports its own at the end.
      if ((type === "DESIGN_READY" || type === "FIX_PROPOSED") && typeof event.revision === "number" && !(await ctx.missions.detail(missionId)).agentBusy) {
        await designFor(missionId, event.revision);
      }
    }
    if (event.kind === "bench.run" && data) {
      const mission = await ctx.store.getMission(missionId);
      const notice = mission ? benchNotice(mission.title, data as unknown as BenchRunResult) : undefined;
      if (notice) await notify({ missionId, category: "bench", key: notice.key, text: notice.text, link: true });
    }
    if (event.kind === "fault" || event.kind === "diagnosis" || event.kind === "bench.failed") {
      const diagnosis = asRecord(data?.diagnosis);
      const summary = stringValue(data?.summary) ?? stringValue(data?.headline) ?? stringValue(diagnosis?.summary) ?? (event.kind === "fault" ? event.text : undefined);
      if (summary) await notify({ missionId, category: "bench", key: `fault:${event.id}`, text: faultAlertText(summary) });
    }
    if (isLaunchEvent(event)) {
      await notify({ missionId, category: "bench", key: "launch", text: "Mission success — the lamp is alive!", celebrate: true });
    }
    if (event.kind === "bench.ask.opened") {
      const ask = benchAskFromEvent(event);
      const target = ask ? await benchTarget(missionId) : undefined;
      if (ask && target) await sendBenchAsk(target.space, ask);
    }
    if (event.kind === "bench.ask.closed") {
      const ask = benchAskFromEvent(event);
      const nested = asRecord(data?.ask) ?? data;
      const askId = ask?.askId ?? stringValue(nested?.askId) ?? stringValue(nested?.id);
      for (const [spaceId, open] of openBenchAskBySpace) {
        if (open.ask.missionId === missionId && (!askId || open.ask.askId === askId)) rememberClosedBenchAsk(spaceId, open);
      }
    }
    if (event.kind === "approval.requested") {
      const notice = approvalFromEvent(event);
      const target = notice && shouldSendApprovalPoll(notice.actionClass) ? await benchTarget(missionId) : undefined;
      if (notice && target) await sendApproval(target.space, notice);
    }
  };

  const unsubscribe = ctx.missions.subscribe("*", (event: TimelineEvent) => {
    pending = pending.then(() => handleTimelineEvent(event)).catch((error: unknown) => ctx.log.warn({ err: error }, "CAPCOM timeline event failed"));
  });

  // ---------- inbound messages ----------

  const handleVote = async (space: CapcomSpace, handle: string, vote: "approve-once" | "deny", pollTitle?: string): Promise<boolean> => {
    const queue = pendingApprovalsBySpace.get(space.id);
    if (!queue) return false;
    const index = pendingApprovalIndex(queue, pollTitle);
    if (index < 0) return false;
    const approval = queue[index];
    if (!approval) return false;
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    const outcome = await ctx.missions.decide(approval.notice.id, vote, actor);
    queue.splice(index, 1);
    if (queue.length === 0) pendingApprovalsBySpace.delete(space.id);
    const result = approvalOutcome(outcome.status, outcome.decision, vote);
    if (result === "approved") {
      await sendText(space, approval.notice.actionClass === "physical" ? "Pre-approval recorded. A human must still click the bench control." : "GO recorded.");
    } else if (result === "denied") {
      await sendText(space, approval.notice.actionClass === "physical" ? "Physical action denied; nothing was run." : "NO-GO recorded.");
    } else {
      await sendText(space, result === "expired" ? "That approval already expired." : "That approval was already decided.");
    }
    return true;
  };

  /** A chat turn's result as replies: Claude's text, then its question (text + poll) or the new design's verdict. */
  const replyWithResult = async (space: CapcomSpace, missionId: string, result: AgentTurnResult, revisionBefore: number | undefined): Promise<void> => {
    if (result.text) await sendText(space, result.text);
    if (result.revision !== undefined && result.revision !== revisionBefore) await designFor(missionId, result.revision, { reply: true });
    if (result.question) {
      const ask = await ctx.runtime.asks.open(missionId);
      if (ask) await notify(askNotice(missionId, ask), { reply: true });
      else await sendText(space, `Question: ${result.question}`);
    }
  };

  /** Answers Claude's open question exactly like the web card; the first answer wins. */
  const answerAsk = async (space: CapcomSpace, missionId: string, askId: string, value: string, actor: Actor): Promise<void> => {
    const open = await ctx.runtime.asks.open(missionId);
    if (open?.askId === askId) await sendText(space, `Got it — "${clip(value, 80)}". Claude is on it.`);
    const before = (await ctx.store.getMission(missionId))?.currentRevision;
    const outcome = await ctx.runtime.asks.answer(missionId, askId, value, actor);
    if (outcome.status === "closed") {
      await sendText(space, alreadyAnsweredText(outcome.by));
      return;
    }
    await replyWithResult(space, missionId, outcome.result, before);
  };

  const answerAskPoll = async (space: CapcomSpace, handle: string, optionTitle: string, pollTitle?: string): Promise<boolean> => {
    const entry = pollTitle ? askPollsBySpace.get(space.id)?.get(pollTitle) : undefined;
    if (!entry) return false;
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    await answerAsk(space, entry.missionId, entry.askId, answerForChoice(entry.choices, optionTitle), actor);
    return true;
  };

  const handlePhoto = async (space: CapcomSpace, handle: string, content: Record<string, unknown>): Promise<void> => {
    const missionId = await activeMission(handle, space.id);
    if (!missionId || typeof content.read !== "function") {
      await sendText(space, "Send a brief first, then attach a photo of the current build step.");
      return;
    }
    const source = new Uint8Array(await (content.read as () => Promise<Uint8Array>)());
    const mime = (stringValue(content.mimeType) ?? "").toLowerCase();
    let jpeg: Uint8Array = source;
    if (mime === "image/heic" || mime === "image/heif" || /\.hei[cf]$/i.test(stringValue(content.name) ?? "")) {
      jpeg = await heifToJpeg(source, { quality: 85 });
    }
    let step = 1;
    try {
      const build = await ctx.missions.build(missionId);
      step = build.current > 0 ? build.current : 1;
    } catch {
      // Photo checks are advisory; the default step is still useful when build state is unavailable.
    }
    const result = await ctx.runtime.checkPhoto({ missionId, step, jpeg: new Uint8Array(jpeg) });
    await sendText(space, `${result.summary}\n${result.answers.map((answer: PhotoPartAnswer) => `${answer.part}: ${answer.status} — ${answer.note}`).join("\n")}`);
  };

  const handleGoForBuild = async (space: CapcomSpace, handle: string, userId: string): Promise<void> => {
    const missionId = await activeMission(handle, space.id);
    if (!missionId) {
      await sendText(space, "No active mission. Reply `mission` to choose one or `brief <what you want to build>` to begin.");
      return;
    }
    const detail = await ctx.missions.detail(missionId);
    const revision = detail.mission.currentRevision;
    if (revision === undefined) {
      await sendText(space, "GO for build isn't ready: checks aren't finished.");
      return;
    }
    try {
      const released = await ctx.runtime.release({ missionId, revision, actor: { kind: "human", id: userId, channel: "imessage" } });
      if (released.mission.releasedRevision === undefined) {
        await sendText(space, "GO for build isn't ready: checks aren't finished.");
        return;
      }
      await sendText(space, `GO for build — the build steps are ready: ${missionLink(missionId)}`);
      await sendStepImage(space, missionId, 1);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "retro_missing") {
        await sendText(space, "Open ViBread to confirm GO without the independent review.");
      } else {
        await sendText(space, "GO for build isn't ready: checks aren't finished.");
      }
    }
  };

  const sendLinkAfterReply = async (space: CapcomSpace, userId: string): Promise<void> => {
    const handle = await ctx.links.handleForUser(userId);
    await sendText(space, `CAPCOM linked to ${handle ?? "your ViBread account"}. Claude's questions and "design ready" notices for all your missions come here.`);
    await send(space, appCard(capcomLinkUrl(ctx.config.phoneUrl, ctx.lanGuard.pairToken()), { live: true }));
    // The contact card is an iMessage feature (the terminal chat would log "unsupported" and skip it).
    if (transport.provider === "cloud") await send(space, nativeContactCard());
  };

  const handleLinkedText = async (space: CapcomSpace, handle: string, userId: string, value: string): Promise<void> => {
    if (awaitingFirstReply.delete(handle)) {
      await sendLinkAfterReply(space, userId);
      return;
    }
    if (await answerBenchAsk(space, handle, value)) return;
    const pendingVote = normalizedVote(value);
    if (pendingVote && (await handleVote(space, handle, pendingVote))) return;
    const normalizedText = value.trim().toLowerCase();
    if (normalizedText === "go" || normalizedText === "go for build") {
      await handleGoForBuild(space, handle, userId);
      return;
    }
    const requested = missionSelection(value);
    if (requested !== undefined) {
      const missions = await ctx.missions.list(userId);
      if (requested === null) {
        if (missions.length === 0) {
          await sendText(space, "You have no missions yet. Reply `brief <what you want to build>` to begin.");
        } else {
          await sendText(space, `Your missions:\n${missions.map((mission, index) => `${index + 1}. ${mission.title} — ${mission.phase}`).join("\n")}\nReply \`mission <number>\` to attach.`);
        }
        return;
      }
      const selected = missions[requested - 1];
      if (!selected) {
        await sendText(space, `Mission ${requested} was not found. Reply \`mission\` to list your missions.`);
        return;
      }
      await attachMission(space.id, handle, selected.id);
      await sendText(space, `Attached to mission ${requested}: ${selected.title}.`);
      return;
    }

    if (normalizedText === "status") {
      const missionId = await activeMission(handle, space.id);
      if (!missionId) {
        await sendText(space, "No active mission. Reply `mission` to choose one or `brief <what you want to build>` to begin.");
        return;
      }
      const detail = await ctx.missions.detail(missionId);
      let next = "";
      let step: number | undefined;
      try {
        const build = await ctx.missions.build(missionId);
        const current = build.steps[build.current - 1];
        if (current) {
          next = `\nNext step: ${current.n} — ${current.title}`;
          if (detail.mission.releasedRevision !== undefined) step = current.n;
        }
      } catch {
        // Status remains useful when no released build exists yet.
      }
      await sendText(space, `${detail.mission.title}\nPhase: ${detail.mission.phase}\nRevision: ${detail.mission.currentRevision ?? "none"}\nPending approvals: ${detail.pendingApprovals.length}${next}`);
      if (step !== undefined) await sendStepImage(space, missionId, step);
      return;
    }

    const actor: Actor = { kind: "human", id: userId, channel: "imessage" };
    const brief = missionBriefFrom(value);
    if (brief) {
      const mission = await ctx.missions.create({ brief, owner: actor, title: brief.slice(0, 80) });
      await attachMission(space.id, handle, mission.id);
      await replyWithResult(space, mission.id, await ctx.missions.say(mission.id, brief, actor), undefined);
      return;
    }

    const missionId = await activeMission(handle, space.id);
    if (!missionId) {
      await sendText(space, "Reply `mission` to choose one or `brief <what you want to build>` to begin.");
      return;
    }
    const open = await ctx.runtime.asks.open(missionId);
    if (open) {
      await answerAsk(space, missionId, open.askId, answerForChoice(open.choices, value), actor);
      return;
    }
    const before = (await ctx.store.getMission(missionId))?.currentRevision;
    await replyWithResult(space, missionId, await ctx.missions.say(missionId, value, actor), before);
  };

  const handleMessage = async (space: CapcomSpace, message: InboundMessage): Promise<void> => {
    spaceCache.set(space.id, space);
    const handle = message.sender?.id ?? space.id;
    const linkedUserId = await ctx.links.userForHandle(handle);
    if (linkedUserId) {
      const binding = await ctx.capcomSpaces.get(space.id);
      if (!binding || binding.userId !== linkedUserId || binding.handle !== handle) await ctx.capcomSpaces.put({ spaceId: space.id, handle, userId: linkedUserId });
      else if (binding.missionId && !activeMissions.has(handle)) activeMissions.set(handle, binding.missionId);
    }
    const content = asRecord(message.content) ?? {};
    const type = stringValue(content.type);
    if (type === "attachment") {
      await handlePhoto(space, handle, content);
      return;
    }
    if (type === "poll_option") {
      if (!isSelectedPollOption(content)) return;
      const optionTitle = stringValue(asRecord(content.option)?.title) ?? stringValue(content.title) ?? "";
      const pollTitle = stringValue(asRecord(content.poll)?.title);
      if (await answerBenchAsk(space, handle, optionTitle, pollTitle)) return;
      if (await answerAskPoll(space, handle, optionTitle, pollTitle)) return;
      const vote = normalizedVote(optionTitle);
      if (vote) await handleVote(space, handle, vote, pollTitle);
      return;
    }
    if (!isSupportedInboundContentType(type)) return;

    const value = contentText(content).trim();
    if (linkedUserId) {
      await handleLinkedText(space, handle, linkedUserId, value);
      return;
    }
    const code = linkCodeFrom(value);
    if (!code) {
      await sendText(space, "CAPCOM is not linked yet. Reply with your one-time ViBread link code.");
      return;
    }
    const redeemed = await ctx.links.redeem(code, handle);
    if (!redeemed) {
      await sendText(space, "That link code is invalid or expired. Request a fresh code in ViBread Settings.");
      return;
    }
    await ctx.capcomSpaces.put({ spaceId: space.id, handle, userId: redeemed.userId });
    awaitingFirstReply.add(handle);
    await sendText(space, "CAPCOM linked. Reply once to continue; links and the contact card come after your reply.");
  };

  const loop = (async () => {
    try {
      for await (const [space, message] of transport.messages) {
        if (stopping) break;
        try {
          await handleMessage(space, message);
        } catch (error) {
          ctx.log.warn({ err: error, spaceId: space.id }, "CAPCOM message failed");
          await sendText(space, "CAPCOM hit a snag. The mission is safe; retry that message or use the laptop workspace.");
        }
      }
    } catch (error) {
      if (!stopping) ctx.log.error({ err: error }, "CAPCOM message loop stopped unexpectedly");
    }
  })();

  const digestTimer = setInterval(() => {
    void flushDigests().catch((error: unknown) => ctx.log.warn({ err: error }, "CAPCOM digest failed"));
  }, DIGEST_INTERVAL_MS);
  digestTimer.unref();
  void flushDigests().catch((error: unknown) => ctx.log.warn({ err: error }, "CAPCOM digest failed"));

  const running: RunningCapcom = {
    provider: transport.provider,
    async sendTest(userId) {
      const target = await targetForUser(userId);
      if (!target) throw new CapcomError(409, "capcom_not_linked", "No iMessage conversation is linked to your account yet. Get a link code and text it to CAPCOM first.");
      try {
        await deliver(target.space, text(TEST_MESSAGE));
      } catch (error) {
        throw new CapcomError(502, "capcom_send_failed", `The message couldn't be sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    flushDigests,
    idle: async () => {
      let seen: Promise<void> | undefined;
      while (seen !== pending) {
        seen = pending;
        await seen;
      }
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(digestTimer);
      unsubscribe();
      if (ctx.capcom.running === running) ctx.capcom.attach(undefined);
      await transport.stop();
      await loop;
    },
  };
  ctx.capcom.attach(running);
  return running;
}

// ---------- configuration and lifecycle (ctx.capcom) ----------

/** Photon credentials saved from Settings. */
export interface PhotonSettings {
  projectId?: string;
  projectSecret?: string;
  number?: string;
}

export interface CapcomStatus {
  provider: "off" | "terminal" | "cloud";
  running: boolean;
  /** Why CAPCOM isn't running although it's configured (the provider's startup error). */
  error?: string;
  /** Settings iMessage still needs, by environment variable name. */
  missing: string[];
  number?: string;
  photon: { projectId?: string; secretSaved: boolean; number?: string; source: "settings" | "env" | "none" };
}

export interface CapcomHandle {
  readonly prefs: CapcomPrefStore;
  readonly running: RunningCapcom | undefined;
  status(): CapcomStatus;
  /** The CAPCOM phone number people text (saved in Settings, else CAPCOM_NUMBER). */
  number(): string | undefined;
  /** Saves Photon credentials (empty strings clear a field) and restarts CAPCOM with them. */
  savePhoton(input: PhotonSettings): Promise<CapcomStatus>;
  sendTest(userId: string): Promise<void>;
  start(ctx: AppContext): Promise<void>;
  stop(): Promise<void>;
  /** Called by runCapcom. */
  attach(running: RunningCapcom | undefined): void;
}

export function createCapcomHandle(deps: { sqlite: SqliteDatabase; config: ServerConfig; log: Logger }): CapcomHandle {
  const prefs = createCapcomPrefStore(deps.sqlite);
  let running: RunningCapcom | undefined;
  let lastError: string | undefined;
  let context: AppContext | undefined;
  let transition: Promise<void> = Promise.resolve();

  const saved = (): PhotonSettings => {
    const row = deps.sqlite.prepare('SELECT "json" FROM "capcom_config" WHERE "key" = ?').get("photon") as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PhotonSettings) : {};
  };

  const effective = () => {
    const stored = saved();
    const env = deps.config.capcom;
    const projectId = stored.projectId ?? env.projectId;
    const projectSecret = stored.projectSecret ?? env.projectSecret;
    const number = stored.number ?? env.number;
    // Credentials saved in Settings switch iMessage on once the effective set (Settings over env) is complete;
    // CAPCOM_PROVIDER=terminal (local testing) still wins.
    const savedAny = Boolean(stored.projectId ?? stored.projectSecret);
    const provider: CapcomStatus["provider"] = env.provider === "terminal" ? "terminal" : savedAny && projectId && projectSecret ? "cloud" : env.provider;
    const source: CapcomStatus["photon"]["source"] = stored.projectId || stored.projectSecret || stored.number ? "settings" : env.projectId || env.projectSecret || env.number ? "env" : "none";
    return { provider, projectId, projectSecret, number, source };
  };

  const startNow = async (ctx: AppContext): Promise<void> => {
    context = ctx;
    lastError = undefined;
    const config = effective();
    if (config.provider === "off") return;
    try {
      if (config.provider === "cloud" && (!config.projectId || !config.projectSecret)) {
        throw new Error("CAPCOM cloud provider requires PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET");
      }
      const transport = await spectrumTransport(config.provider, config.provider === "cloud" ? { projectId: config.projectId!, projectSecret: config.projectSecret! } : undefined);
      runCapcom(ctx, transport);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.log.error({ err: lastError }, "CAPCOM could not start");
    }
  };

  const stopNow = async (): Promise<void> => {
    const current = running;
    running = undefined;
    await current?.stop();
  };

  const handle: CapcomHandle = {
    prefs,
    get running() {
      return running;
    },
    status() {
      const config = effective();
      const missing = config.provider === "terminal"
        ? []
        : [
            ...(config.provider === "off" ? ["CAPCOM_PROVIDER=cloud"] : []),
            ...(config.projectId ? [] : ["PHOTON_PROJECT_ID"]),
            ...(config.projectSecret ? [] : ["PHOTON_PROJECT_SECRET"]),
            ...(config.number ? [] : ["CAPCOM_NUMBER"]),
          ];
      return {
        provider: config.provider,
        running: running !== undefined,
        ...(lastError ? { error: lastError } : {}),
        missing,
        ...(config.number ? { number: config.number } : {}),
        photon: { ...(config.projectId ? { projectId: config.projectId } : {}), secretSaved: Boolean(config.projectSecret), ...(config.number ? { number: config.number } : {}), source: config.source },
      };
    },
    number: () => effective().number,
    async savePhoton(input) {
      const next: PhotonSettings = { ...saved() };
      for (const key of ["projectId", "projectSecret", "number"] as const) {
        const value = input[key];
        if (value === undefined) continue;
        if (typeof value !== "string") throw new CapcomError(400, "INVALID_PHOTON_SETTINGS", `${key} must be text.`);
        if (value.trim()) next[key] = value.trim();
        else delete next[key];
      }
      deps.sqlite
        .prepare('INSERT INTO "capcom_config" ("key", "json", "updatedAt") VALUES (?, ?, ?) ON CONFLICT("key") DO UPDATE SET "json" = excluded."json", "updatedAt" = excluded."updatedAt"')
        .run("photon", JSON.stringify(next), Date.now());
      const ctx = context;
      if (ctx) {
        transition = transition.then(async () => {
          await stopNow();
          await startNow(ctx);
        });
        await transition;
      }
      return handle.status();
    },
    async sendTest(userId) {
      if (!running) {
        const status = handle.status();
        throw new CapcomError(
          409,
          "capcom_off",
          status.error ? `CAPCOM isn't running: ${status.error}` : `CAPCOM is off on this server. Set ${status.missing.join(", ")} (or save the Photon settings below).`,
        );
      }
      await running.sendTest(userId);
    },
    async start(ctx) {
      transition = transition.then(() => startNow(ctx));
      await transition;
    },
    async stop() {
      transition = transition.then(stopNow);
      await transition;
    },
    attach(next) {
      running = next;
    },
  };
  return handle;
}

/** Starts CAPCOM for the server (main.ts): the configured provider, or nothing when it's off. */
export async function startCapcom(ctx: AppContext): Promise<{ stop(): Promise<void> }> {
  await ctx.capcom.start(ctx);
  return { stop: () => ctx.capcom.stop() };
}
