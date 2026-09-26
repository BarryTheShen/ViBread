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
import type { Actor, ApprovalRequest, PhotoPartAnswer, TimelineEvent } from "@vibread/core";
import type { AppContext } from "../context.js";

interface CapcomApp {
  readonly messages: AsyncIterable<[Space, Message]>;
  stop(): Promise<void>;
}

interface ApprovalNotice {
  id: string;
  missionId: string;
  actionClass: ApprovalRequest["actionClass"];
  summary: string;
  consequence: string;
}

export interface CapcomSpaces {
  get(spaceId: string): Promise<{ spaceId: string; handle: string; userId: string; missionId?: string | null } | null>;
  put(input: { spaceId: string; handle: string; userId: string; missionId?: string | null }): Promise<{ spaceId: string; handle: string; userId: string; missionId?: string | null }>;
  setMission(spaceId: string, missionId: string | null): Promise<{ spaceId: string; handle: string; userId: string; missionId?: string | null } | null>;
  listForMission(missionId: string): Promise<{ spaceId: string; handle: string; userId: string; missionId?: string | null }[]>;
}

interface PendingApproval {
  notice: ApprovalNotice;
  pollTitle: string;
}

export interface BenchAsk {
  missionId: string;
  askId: string;
  test: string;
  kind: string;
  part?: string;
  prompt: string;
  choices: string[];
  createdAt: number;
  expiresAt: number;
  status: "open" | "answered" | "closed";
  answer?: string;
  answeredBy?: Actor;
}

export interface BenchAsks {
  open(input: { missionId: string; askId: string; test: string; kind: string; part?: string; prompt: string; choices: string[]; timeoutMs: number }): BenchAsk;
  answer(missionId: string, askId: string, value: string, actor: Actor): boolean;
  close(missionId: string, askId: string, answer?: string): void;
  get(missionId: string, askId: string): BenchAsk | undefined;
  current(missionId: string): BenchAsk | undefined;
}
interface SendState {
  readonly cloud: boolean;
  lastSentAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentRecord(message: Message): Record<string, unknown> {
  return asRecord(message.content) ?? {};
}

function contentText(message: Message): string {
  const content = contentRecord(message);
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

function senderHandle(space: Space, message: Message): string {
  return message.sender?.id ?? space.id;
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
  if (!id || !missionId || (actionClass !== "physical" && actionClass !== "read-only" && actionClass !== "state-changing" && actionClass !== "release" && actionClass !== "bom-change")) return undefined;
  return {
    id,
    missionId,
    actionClass,
    summary: stringValue(nested.summary) ?? "Approval requested",
    consequence: stringValue(nested.consequence) ?? "This action changes the mission.",
  };
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

function eventSummary(event: TimelineEvent): string | undefined {
  const data = asRecord(event.data);
  const diagnosis = asRecord(data?.diagnosis);
  return stringValue(data?.summary) ?? stringValue(data?.headline) ?? stringValue(diagnosis?.summary) ?? (event.kind === "fault" ? event.text : undefined);
}

export function faultAlertText(summary: string): string {
  const normalized = summary.trim();
  if (/^Houston,\s+we have a problem\s*:/i.test(normalized)) return normalized;
  return `Houston, we have a problem: ${normalized}`;
}
export function isFaultAlertEvent(event: TimelineEvent): boolean {
  if (event.kind !== "bench.run") return event.kind === "fault" || event.kind === "diagnosis" || event.kind === "bench.failed";
  return asRecord(event.data)?.verdict === "fail";
}
export function shouldSendCelebrationEffect(cloud: boolean): boolean {
  return cloud;
}

function isLaunchEvent(event: TimelineEvent): boolean {
  if (event.kind === "mission.launched" || event.kind === "launch" || event.kind === "launched") return true;
  const data = asRecord(event.data);
  return data?.phase === "LAUNCH" || data?.phase === "DONE" || data?.type === "LAUNCHED";
}

function buildStepFromEvent(event: TimelineEvent): number | undefined {
  const data = asRecord(event.data);
  const value = data?.step ?? data?.n;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function artifactHashFromEvent(event: TimelineEvent, step: number): string | undefined {
  const data = asRecord(event.data);
  const direct = stringValue(data?.artifactHash) ?? stringValue(data?.hash);
  if (direct) return direct;
  const artifact = asRecord(data?.artifact);
  return stringValue(artifact?.hash) ?? stringValue(artifact?.contentHash) ?? `step-${step}.png`;
}

function configForCloud(ctx: AppContext): { projectId: string; projectSecret: string } {
  const projectId = ctx.config.capcom.projectId ?? process.env.PHOTON_PROJECT_ID;
  const projectSecret = ctx.config.capcom.projectSecret ?? process.env.PHOTON_PROJECT_SECRET;
  if (!projectId || !projectSecret) throw new Error("CAPCOM cloud provider requires PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET");
  return { projectId, projectSecret };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function isQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 23 || hour < 7;
}

export function cloudSendDelayMs(elapsed: number): number {
  return Math.max(0, 750 - elapsed);
}


function createSender(ctx: AppContext, state: SendState) {
  return async (space: Space, content: ContentBuilder): Promise<boolean> => {
    if (state.cloud) {
      if (isQuietHours() && process.env.CAPCOM_ALLOW_OFF_HOURS !== "1") {
        ctx.log.warn({ spaceId: space.id }, "CAPCOM cloud send skipped during quiet hours");
        return false;
      }
      const elapsed = Date.now() - state.lastSentAt;
      const delay = cloudSendDelayMs(elapsed);
      if (delay > 0) await wait(delay);
    }
    try {
      await space.responding(async () => {
        await space.send(content);
      });
      state.lastSentAt = Date.now();
      return true;
    } catch (error) {
      ctx.log.warn({ err: error, spaceId: space.id }, "CAPCOM send failed");
      return false;
    }
  };
}

/** Start CAPCOM's long-lived Spectrum message loop. */
export async function startCapcom(ctx: AppContext): Promise<{ stop(): Promise<void> }> {
  const provider = ctx.config.capcom.provider;
  if (provider === "off") return { stop: async () => undefined };

  const app = (provider === "terminal"
    ? await Spectrum({ providers: [terminal.config()] })
    : await Spectrum({ ...configForCloud(ctx), providers: [imessage.config()] })) as unknown as CapcomApp;
  const sendState: SendState = { cloud: provider === "cloud", lastSentAt: 0 };
  const send = createSender(ctx, sendState);
  const capcomSpaces = (ctx as AppContext & { capcomSpaces?: CapcomSpaces }).capcomSpaces;
  const benchRelayContext = ctx as unknown as { benchAsks?: BenchAsks };
  const benchAsks = benchRelayContext.benchAsks;
  const activeMissions = new Map<string, string>();
  const spacesByMission = new Map<string, Space>();
  const awaitingFirstReply = new Set<string>();
  const pendingApprovalsBySpace = new Map<string, PendingApproval[]>();
  const openBenchAskBySpace = new Map<string, { ask: BenchAsk; pollTitle: string }>();
  const closedBenchPollsBySpace = new Map<string, Set<string>>();
  const closedBenchChoicesBySpace = new Map<string, Set<string>>();
  let stopping = false;

  const rememberBinding = async (space: Space, handle: string, userId: string): Promise<void> => {
    if (!capcomSpaces) return;
    try {
      const binding = await capcomSpaces.get(space.id);
      if (!binding) {
        await capcomSpaces.put({ spaceId: space.id, handle, userId });
        return;
      }
      if (binding.userId === userId && binding.missionId) {
        activeMissions.set(handle, binding.missionId);
        spacesByMission.set(binding.missionId, space);
      }
    } catch (error) {
      ctx.log.warn({ err: error, spaceId: space.id }, "CAPCOM space lookup failed");
    }
  };

  const persistBinding = async (space: Space, handle: string, userId: string): Promise<void> => {
    if (!capcomSpaces) return;
    try {
      await capcomSpaces.put({ spaceId: space.id, handle, userId });
    } catch (error) {
      ctx.log.warn({ err: error, spaceId: space.id }, "CAPCOM space binding failed");
    }
  };

  const attachMission = async (space: Space, handle: string, missionId: string): Promise<void> => {
    activeMissions.set(handle, missionId);
    spacesByMission.set(missionId, space);
    if (!capcomSpaces) return;
    try {
      await capcomSpaces.setMission(space.id, missionId);
    } catch (error) {
      ctx.log.warn({ err: error, spaceId: space.id, missionId }, "CAPCOM mission attachment failed");
    }
  };

  const rememberClosedBenchAsk = (space: Space, pending: { ask: BenchAsk; pollTitle: string }): void => {
    openBenchAskBySpace.delete(space.id);
    const closedPolls = closedBenchPollsBySpace.get(space.id) ?? new Set<string>();
    closedPolls.add(pending.pollTitle);
    closedBenchPollsBySpace.set(space.id, closedPolls);
    const closedChoices = closedBenchChoicesBySpace.get(space.id) ?? new Set<string>();
    for (const choice of pending.ask.choices) {
      closedChoices.add(choice.trim().toLowerCase());
      closedChoices.add(benchAskOptionTitle(choice).trim().toLowerCase());
    }
    closedBenchChoicesBySpace.set(space.id, closedChoices);
  };

  const sendText = async (space: Space, value: string): Promise<void> => {
    await send(space, text(value));
  };

  const sendLinkAfterReply = async (space: Space, userId: string): Promise<void> => {
    const handle = await ctx.links.handleForUser(userId);
    await sendText(space, `CAPCOM linked to ${handle ?? "your ViBread account"}.`);
    await send(space, appCard(`${ctx.config.publicUrl.replace(/\/$/, "")}/`, { live: true }));
    await send(space, nativeContactCard());
  };

  const actorForHandle = async (handle: string): Promise<Actor | undefined> => {
    const userId = await ctx.links.userForHandle(handle);
    return userId ? { kind: "human", id: userId, channel: "imessage" } : undefined;
  };

  const sendApproval = async (space: Space, notice: ApprovalNotice): Promise<void> => {
    const queue = pendingApprovalsBySpace.get(space.id) ?? [];
    const pollTitle = pollTitleForApproval(notice);
    queue.push({ notice, pollTitle });
    pendingApprovalsBySpace.set(space.id, queue);
    const pollContent = poll(
      pollTitle,
      option("GO"),
      option("NO-GO"),
    );
    await send(space, pollContent);
    await sendText(space, `Reply GO or NO-GO. ${notice.consequence}`);
  };

  const sendBenchAsk = async (space: Space, ask: BenchAsk): Promise<void> => {
    if (openBenchAskBySpace.has(space.id)) return;
    const pollTitle = ask.prompt;
    openBenchAskBySpace.set(space.id, { ask, pollTitle });
    await send(space, poll(
      pollTitle,
      ...ask.choices.map((choice) => option(benchAskOptionTitle(choice))),
    ));
    await sendText(space, `Reply ${ask.choices.map(benchAskOptionTitle).join(" / ")}.`);
  };

  const answerBenchAsk = async (space: Space, handle: string, optionTitle: string, pollTitle?: string): Promise<boolean> => {
    const pending = openBenchAskBySpace.get(space.id);
    if (!pending) {
      const closed = closedBenchPollsBySpace.get(space.id);
      const closedChoices = closedBenchChoicesBySpace.get(space.id);
      if ((pollTitle && closed?.has(pollTitle)) || closedChoices?.has(optionTitle.trim().toLowerCase())) {
        await sendText(space, "That question already closed.");
        return true;
      }
      return false;
    }
    const value = benchAskValueForOption(pending.ask, optionTitle);
    if (!value) {
      await sendText(space, `Reply ${pending.ask.choices.map(benchAskOptionTitle).join(" / ")}.`);
      return true;
    }
    if (!benchAsks) return false;
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    try {
      const answered = await benchAsks.answer(pending.ask.missionId, pending.ask.askId, value, actor);
      if (!answered) {
        rememberClosedBenchAsk(space, pending);
        await sendText(space, "That question already closed.");
        return true;
      }
      rememberClosedBenchAsk(space, pending);
      await sendText(space, "Answer recorded.");
      return true;
    } catch {
      rememberClosedBenchAsk(space, pending);
      await sendText(space, "That question already closed.");
      return true;
    }
  };


  const sendStepImage = async (space: Space, event: TimelineEvent): Promise<void> => {
    const step = buildStepFromEvent(event);
    const missionId = missionIdFromEvent(event);
    if (!step || !missionId) return;
    const hash = artifactHashFromEvent(event, step);
    let artifact = hash ? await ctx.store.getArtifact(hash) : null;
    if (!artifact && hash === `step-${step}.png`) {
      const revision = await ctx.store.getRevision(missionId);
      const revisionHash = revision?.results.artifacts[hash];
      if (revisionHash) artifact = await ctx.store.getArtifact(revisionHash);
    }
    if (!artifact || !artifact.contentType.toLowerCase().includes("png")) return;
    await send(space, attachment(Buffer.from(artifact.data), { name: `step-${step}.png`, mimeType: "image/png" }));
  };

  const handleTimelineEvent = async (event: TimelineEvent): Promise<void> => {
    const missionId = missionIdFromEvent(event);
    if (!missionId) return;
    const space = spacesByMission.get(missionId);
    if (!space) return;
    if (event.kind === "bench.ask.opened") {
      const ask = benchAskFromEvent(event);
      if (ask) await sendBenchAsk(space, ask);
    }
    if (event.kind === "bench.ask.closed") {
      const ask = benchAskFromEvent(event);
      const raw = asRecord(event.data);
      const nested = asRecord(raw?.ask) ?? raw;
      const askId = ask?.askId ?? stringValue(nested?.askId) ?? stringValue(nested?.id);
      const pending = openBenchAskBySpace.get(space.id);
      if (pending && (!askId || pending.ask.askId === askId)) rememberClosedBenchAsk(space, pending);
    }
    if (event.kind === "approval.requested") {
      const notice = approvalFromEvent(event);
      if (notice) await sendApproval(space, notice);
    }
    if (isFaultAlertEvent(event)) {
      const summary = eventSummary(event);
      if (summary) await sendText(space, faultAlertText(summary));
    }
    if (isLaunchEvent(event)) {
      const celebrated = shouldSendCelebrationEffect(sendState.cloud)
        ? await send(space, effect(text("Mission success — the lamp is alive!"), imessage.effect.message.celebration))
        : false;
      if (!celebrated) await sendText(space, "Mission success — the lamp is alive!");
    }
  };

  const unsubscribe = ctx.missions.subscribe("*", (event: TimelineEvent) => {
    void handleTimelineEvent(event).catch((error: unknown) => ctx.log.warn({ err: error }, "CAPCOM timeline event failed"));
  });

  const handleVote = async (space: Space, handle: string, vote: "approve-once" | "deny", pollTitle?: string): Promise<boolean> => {
    const queue = pendingApprovalsBySpace.get(space.id);
    if (!queue) return false;
    const index = pendingApprovalIndex(queue, pollTitle);
    if (index < 0) return false;
    const [pending] = queue.splice(index, 1);
    if (!pending) return false;
    if (queue.length === 0) pendingApprovalsBySpace.delete(space.id);
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    await ctx.missions.decide(pending.notice.id, vote, actor);
    if (pending.notice.actionClass === "physical") {
      await sendText(space, vote === "approve-once" ? "Pre-approval recorded. A human must still click the bench control." : "Physical action denied; nothing was run.");
    } else {
      await sendText(space, vote === "approve-once" ? "GO recorded." : "NO-GO recorded.");
    }
    return true;
  };

  const handlePhoto = async (space: Space, handle: string, message: Message): Promise<void> => {
    const missionId = activeMissions.get(handle);
    const content = contentRecord(message);
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

  const handleLinkedText = async (space: Space, handle: string, userId: string, value: string): Promise<void> => {
    if (awaitingFirstReply.delete(handle)) {
      await sendLinkAfterReply(space, userId);
      return;
    }
    if (await answerBenchAsk(space, handle, value)) return;
    const pendingVote = normalizedVote(value);
    if (pendingVote && (await handleVote(space, handle, pendingVote))) return;
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
      await attachMission(space, handle, selected.id);
      await sendText(space, `Attached to mission ${requested}: ${selected.title}.`);
      return;
    }

    if (value.trim().toLowerCase() === "status") {
      const missionId = activeMissions.get(handle);
      if (!missionId) {
        await sendText(space, "No active mission. Reply `mission` to choose one or `brief <what you want to build>` to begin.");
        return;
      }
      const detail = await ctx.missions.detail(missionId);
      await sendText(space, `${detail.mission.title}\nPhase: ${detail.mission.phase}\nRevision: ${detail.mission.currentRevision ?? "none"}\nPending approvals: ${detail.pendingApprovals.length}`);
      return;
    }

    const brief = missionBriefFrom(value);
    if (brief) {
      const actor: Actor = { kind: "human", id: userId, channel: "imessage" };
      const mission = await ctx.missions.create({ brief, inventory: [], owner: actor, title: brief.slice(0, 80) });
      await attachMission(space, handle, mission.id);
      const result = await ctx.missions.say(mission.id, brief, actor);
      await sendText(space, result.question ? `${result.text}\nQuestion: ${result.question}` : result.text);
      return;
    }

    const missionId = activeMissions.get(handle);
    if (!missionId) {
      await sendText(space, "Reply `mission` to choose one or `brief <what you want to build>` to begin.");
      return;
    }
    spacesByMission.set(missionId, space);
    const actor: Actor = { kind: "human", id: userId, channel: "imessage" };
    const result = await ctx.missions.say(missionId, value, actor);
    await sendText(space, result.question ? `${result.text}\nQuestion: ${result.question}` : result.text);
  };

  const handleMessage = async (space: Space, message: Message): Promise<void> => {
    const handle = senderHandle(space, message);
    const linkedUserId = await ctx.links.userForHandle(handle);
    if (linkedUserId) await rememberBinding(space, handle, linkedUserId);
    const content = contentRecord(message);
    const type = stringValue(content.type);
    if (type === "attachment") {
      await handlePhoto(space, handle, message);
      return;
    }
    if (type === "poll_option") {
      const optionValue = asRecord(content.option);
      const pollValue = asRecord(content.poll);
    if (type === "poll_option") {
      if (!isSelectedPollOption(content)) return;
      const optionValue = asRecord(content.option);
      const pollValue = asRecord(content.poll);
      const optionTitle = stringValue(optionValue?.title) ?? stringValue(content.title) ?? "";
      const pollTitle = stringValue(pollValue?.title);
      if (await answerBenchAsk(space, handle, optionTitle, pollTitle)) return;
      const vote = normalizedVote(optionTitle);
      if (vote) await handleVote(space, handle, vote, pollTitle);
      return;
    }
    if (!isSupportedInboundContentType(type)) return;

    const value = contentText(message).trim();
    const waiting = awaitingFirstReply.has(handle);
    const userId = linkedUserId;
    if (waiting && userId) {
      await handleLinkedText(space, handle, userId, value);
      return;
    }
    if (!userId) {
      const code = linkCodeFrom(value);
      if (code) {
        const redeemed = await ctx.links.redeem(code, handle);
        if (redeemed) {
          await persistBinding(space, handle, redeemed.userId);
          awaitingFirstReply.add(handle);
          await sendText(space, "CAPCOM linked. Reply once to continue; links and the contact card come after your reply.");
        } else {
          await sendText(space, "That link code is invalid or expired. Request a fresh code in ViBread Settings.");
        }
      } else {
        await sendText(space, "CAPCOM is not linked yet. Reply with your one-time ViBread link code.");
      }
      return;
    }
    await handleLinkedText(space, handle, userId, value);
  };

  const loop = (async () => {
    try {
      for await (const [space, message] of app.messages) {
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

  return {
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      unsubscribe();
      await app.stop();
      await loop;
    },
  };
}