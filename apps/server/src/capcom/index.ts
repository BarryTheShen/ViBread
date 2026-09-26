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
import type { Actor, ApprovalRequest, TimelineEvent } from "@vibread/core";
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

function eventSummary(event: TimelineEvent): string | undefined {
  const data = asRecord(event.data);
  const diagnosis = asRecord(data?.diagnosis);
  return stringValue(data?.summary) ?? stringValue(data?.headline) ?? stringValue(diagnosis?.summary) ?? (event.kind === "fault" ? event.text : undefined);
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

function isQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 23 || hour < 7;
}

function createSender(ctx: AppContext, state: SendState) {
  return async (space: Space, content: ContentBuilder): Promise<boolean> => {
    if (state.cloud) {
      if (isQuietHours() && process.env.CAPCOM_ALLOW_OFF_HOURS !== "1") {
        ctx.log.warn({ spaceId: space.id }, "CAPCOM cloud send skipped during quiet hours");
        return false;
      }
      const elapsed = Date.now() - state.lastSentAt;
      if (elapsed < 750) await wait(750 - elapsed);
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
  const activeMissions = new Map<string, string>();
  const spacesByMission = new Map<string, Space>();
  const awaitingFirstReply = new Set<string>();
  const pendingApprovalsBySpace = new Map<string, ApprovalNotice[]>();
  let stopping = false;

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
    queue.push(notice);
    pendingApprovalsBySpace.set(space.id, queue);
    const pollContent = poll(
      `Mission approval: ${notice.summary}`,
      option("GO"),
      option("NO-GO"),
    );
    await send(space, pollContent);
    await sendText(space, `Reply GO or NO-GO. ${notice.consequence}`);
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
    if (event.kind === "approval.requested") {
      const notice = approvalFromEvent(event);
      if (notice) await sendApproval(space, notice);
    }
    if (event.kind === "build.step" || event.kind === "step") await sendStepImage(space, event);
    if (event.kind === "fault" || event.kind === "diagnosis" || event.kind === "bench.run" || event.kind === "bench.failed") {
      const summary = eventSummary(event);
      if (summary) await sendText(space, `Houston, we have a problem: ${summary}`);
    }
    if (isLaunchEvent(event)) {
      const celebrated = await send(space, effect(text("Mission success — the lamp is alive!"), imessage.effect.message.celebration));
      if (!celebrated) await sendText(space, "Mission success — the lamp is alive!");
    }
  };

  const unsubscribe = ctx.missions.subscribe("*", (event: TimelineEvent) => {
    void handleTimelineEvent(event).catch((error: unknown) => ctx.log.warn({ err: error }, "CAPCOM timeline event failed"));
  });

  const handleVote = async (space: Space, handle: string, vote: "approve-once" | "deny"): Promise<boolean> => {
    const queue = pendingApprovalsBySpace.get(space.id);
    const notice = queue?.shift();
    if (!notice) return false;
    if (queue && queue.length === 0) pendingApprovalsBySpace.delete(space.id);
    const actor = await actorForHandle(handle);
    if (!actor) return false;
    await ctx.missions.decide(notice.id, vote, actor);
    if (notice.actionClass === "physical") {
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
    await sendText(space, `${result.summary}\n${result.answers.map((answer) => `${answer.part}: ${answer.status} — ${answer.note}`).join("\n")}`);
  };

  const handleLinkedText = async (space: Space, handle: string, userId: string, value: string): Promise<void> => {
    if (awaitingFirstReply.delete(handle)) {
      await sendLinkAfterReply(space, userId);
      return;
    }
    const pendingVote = normalizedVote(value);
    if (pendingVote && (await handleVote(space, handle, pendingVote))) return;

    if (value.trim().toLowerCase() === "status") {
      const missionId = activeMissions.get(handle);
      if (!missionId) {
        await sendText(space, "No active mission. Reply `brief <what you want to build>` to begin.");
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
      activeMissions.set(handle, mission.id);
      spacesByMission.set(mission.id, space);
      const result = await ctx.missions.say(mission.id, brief, actor);
      await sendText(space, result.question ? `${result.text}\nQuestion: ${result.question}` : result.text);
      return;
    }

    const missionId = activeMissions.get(handle);
    if (!missionId) {
      await sendText(space, "Reply `brief <what you want to build>` to begin a mission.");
      return;
    }
    spacesByMission.set(missionId, space);
    const actor: Actor = { kind: "human", id: userId, channel: "imessage" };
    const result = await ctx.missions.say(missionId, value, actor);
    await sendText(space, result.question ? `${result.text}\nQuestion: ${result.question}` : result.text);
  };

  const handleMessage = async (space: Space, message: Message): Promise<void> => {
    const handle = senderHandle(space, message);
    const content = contentRecord(message);
    const type = stringValue(content.type);
    if (type === "attachment") {
      await handlePhoto(space, handle, message);
      return;
    }
    if (type === "poll_option") {
      const optionValue = asRecord(content.option);
      const vote = normalizedVote(stringValue(optionValue?.title) ?? stringValue(content.title) ?? "");
      if (vote) await handleVote(space, handle, vote);
      return;
    }
    if (type === "reaction") return;

    const value = contentText(message).trim();
    const waiting = awaitingFirstReply.has(handle);
    const userId = await ctx.links.userForHandle(handle);
    if (waiting && userId) {
      await handleLinkedText(space, handle, userId, value);
      return;
    }
    if (!userId) {
      const code = linkCodeFrom(value);
      if (code) {
        const redeemed = await ctx.links.redeem(code, handle);
        if (redeemed) {
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