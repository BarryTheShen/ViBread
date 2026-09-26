import { CONSOLE_IDS, type RevisionSummary, type TimelineEvent, type Verdict } from "@vibread/core";
import type { PanelView } from "../contracts.js";
import { isRecord } from "../lib/guards.js";

/**
 * Timeline events (GET /api/missions/:id/timeline) merged into the mission chat (docs/ui-redesign-plan.md §3.2): which
 * events become rows, how consecutive ones group ("Steps 1–11 done", one "Checks" row per revision), where each row sits
 * between the chat messages, and which panel view a row opens.
 */

/** Consecutive events rendered as one row. `events` is never empty and is in time order. */
export interface TimelineItem {
  key: string;
  group: "checks" | "steps" | null;
  events: TimelineEvent[];
}

export type RowTone = "neutral" | "success" | "warning" | "error" | "info";

/** What a row shows and opens (pure; rendered by chat/TimelineRow.tsx). */
export interface RowModel {
  icon: "design" | "tests" | "checks" | "go" | "steps" | "photo" | "bench" | "done" | "recorded" | "parts" | "phase" | "info";
  title: string;
  /** Short trailing status ("all GO", "pass", "3 GO · 1 PENDING"). */
  status?: string;
  tone: RowTone;
  /** Lines shown when the row is expanded. */
  details: string[];
  /** Panel view the row opens; rows without one are not clickable. */
  view?: PanelView;
  revision?: number;
  /** Recorded-run label ("Recorded run · Claude Opus 5.5 · Sep 26"), shown as a chip. */
  recorded?: string;
}

/** Events that never become rows: noise, or already shown elsewhere in the chat (messages, approval cards). */
const HIDDEN_KINDS: Record<string, true> = {
  "mission.created": true,
  message: true,
  "agent.credential": true,
  "faults.ready": true,
  "approval.requested": true,
  "approval.decided": true,
  // Permission modes were removed; older missions still carry these events.
  "mode.changed": true,
  "bench.ask.opened": true,
  "bench.ask.closed": true,
  "bench.ask.answered": true,
};

/** Machine phase events worth a row; the rest duplicate another row (RELEASED ↔ revision.released, BUILD_STEP ↔ build.step …). */
const SHOWN_PHASE_EVENTS: Record<string, true> = { DESIGN_READY: true, BUILD_DONE: true, VERIFY_FAILED: true, FIX_PROPOSED: true };

function phaseEventType(event: TimelineEvent): string | undefined {
  if (!isRecord(event.data) || !isRecord(event.data.event)) return undefined;
  return typeof event.data.event.type === "string" ? event.data.event.type : undefined;
}

export function isShownEvent(event: TimelineEvent): boolean {
  if (HIDDEN_KINDS[event.kind]) return false;
  if (event.kind === "phase.changed") {
    const type = phaseEventType(event);
    return type !== undefined && SHOWN_PHASE_EVENTS[type] === true;
  }
  return true;
}

function groupOf(event: TimelineEvent): TimelineItem["group"] {
  if (event.kind === "console.report") return "checks";
  if (event.kind === "build.step") return "steps";
  return null;
}

/** Visible events → rows, grouping consecutive check reports of one revision and consecutive build steps. */
export function groupTimeline(events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (!isShownEvent(event)) continue;
    const group = groupOf(event);
    // The server logs "ready for GO" in the same millisecond as the last reports, so it can land between them; the
    // checks row then collects its stragglers from just behind that phase row.
    const previous = items.at(-1)?.events[0];
    const straddled = previous?.kind === "phase.changed" && Date.parse(event.at) - Date.parse(previous.at) < 1_000 ? items.at(-2) : undefined;
    const last = group === "checks" && straddled?.group === "checks" ? straddled : items.at(-1);
    if (group && last && last.group === group && (group !== "checks" || last.events[0].revision === event.revision)) {
      last.events.push(event);
      continue;
    }
    items.push({ key: event.id, group, events: [event] });
  }
  return items;
}

/**
 * Pre-warmed and imported designs are stored without a `revision.created` event; a row for each such revision (from
 * GET revisions) keeps the story complete: design → checks → release.
 */
export function withRevisionEvents(events: TimelineEvent[], revisions: RevisionSummary[], missionId: string): TimelineEvent[] {
  const logged = new Set(events.flatMap((e) => (e.kind === "revision.created" && e.revision !== undefined ? [e.revision] : [])));
  const missing = revisions
    .filter((r) => !logged.has(r.n))
    .map(
      (r): TimelineEvent => ({
        id: `revision-${r.n}`,
        missionId,
        at: r.createdAt,
        channel: r.author.channel,
        actor: r.author,
        kind: "revision.created",
        text: `Revision ${r.n}: ${r.note ?? "design"}`,
        revision: r.n,
      }),
    );
  return missing.length === 0 ? events : [...events, ...missing];
}

/** Where rows sit between chat messages: `before[messageId]` = rows shown just above that message; `end` = after the last. */
export interface ChatTimeline {
  before: Record<string, TimelineItem[]>;
  end: TimelineItem[];
}

export interface ChatMessageLike {
  id: string;
  role: string;
  metadata?: unknown;
}

function isRecordedMessage(metadata: unknown): boolean {
  return isRecord(metadata) && isRecord(metadata.vibread) && isRecord(metadata.vibread.recorded);
}

/**
 * Chat messages carry no timestamps; the server logs one `message` timeline event per user message (actor human) when
 * a run starts. The k-th live user message is matched to the k-th such event; a message not logged yet (just sent) sorts
 * after everything, and a recorded run's replayed brief sorts before everything. Each shown event goes right above the
 * first user message sent after it (i.e. at the end of the turn it happened in), otherwise after the last message.
 */
export function placeTimeline(messages: ChatMessageLike[], events: TimelineEvent[]): ChatTimeline {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const humanTimes = sorted.filter((e) => e.kind === "message" && e.actor.kind === "human").map((e) => Date.parse(e.at));
  const anchors: Array<{ id: string; time: number }> = [];
  let live = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (isRecordedMessage(message.metadata)) {
      anchors.push({ id: message.id, time: Number.NEGATIVE_INFINITY });
      continue;
    }
    anchors.push({ id: message.id, time: humanTimes[live] ?? Number.POSITIVE_INFINITY });
    live += 1;
  }

  const buckets = new Map<string, TimelineEvent[]>();
  const endEvents: TimelineEvent[] = [];
  for (const event of sorted) {
    if (!isShownEvent(event)) continue;
    const at = Date.parse(event.at);
    const anchor = anchors.find((a) => a.time > at);
    if (!anchor) {
      endEvents.push(event);
      continue;
    }
    const bucket = buckets.get(anchor.id);
    if (bucket) bucket.push(event);
    else buckets.set(anchor.id, [event]);
  }
  const before: Record<string, TimelineItem[]> = {};
  for (const [id, list] of buckets) before[id] = groupTimeline(list);
  return { before, end: groupTimeline(endEvents) };
}

// ---------- row wording ----------

function numberRanges(values: number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  if (start !== undefined) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(", ");
}

function verdictOf(event: TimelineEvent): Verdict | undefined {
  if (!isRecord(event.data)) return undefined;
  const v = event.data.verdict;
  return v === "GO" || v === "NO-GO" || v === "PENDING" || v === "SKIPPED" ? v : undefined;
}

function recordedOf(event: TimelineEvent): string | undefined {
  if (!isRecord(event.data)) return undefined;
  if (event.kind === "mission.recorded") return typeof event.data.label === "string" ? event.data.label : undefined;
  const mark = event.data.recorded;
  return isRecord(mark) && typeof mark.label === "string" ? mark.label : undefined;
}

function whoDid(event: TimelineEvent): string {
  if (event.actor.kind === "human") return event.actor.channel === "web" ? "by you" : `by you (${channelName(event.actor.channel)})`;
  if (event.actor.kind === "agent") return event.actor.channel === "mcp" ? "by Claude Code" : "by Claude";
  return "automatically";
}

function channelName(channel: TimelineEvent["channel"]): string {
  return channel === "imessage" ? "iMessage" : channel === "mcp" ? "Claude Code" : channel === "a2a" ? "another agent" : channel === "web" ? "this app" : "ViBread";
}

function checksRow(item: TimelineItem): RowModel {
  const revision = item.events[0].revision;
  // A console can report twice for one revision (RETRO after the others); keep its latest verdict.
  const latest = new Map<string, Verdict>();
  for (const event of item.events) {
    const consoleId = isRecord(event.data) && typeof event.data.console === "string" ? event.data.console : event.id;
    const verdict = verdictOf(event);
    if (verdict) latest.set(consoleId, verdict);
  }
  const verdicts = [...latest.values()];
  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  const allGo = verdicts.length > 0 && verdicts.every((v) => v === "GO");
  const status = allGo
    ? verdicts.length === CONSOLE_IDS.length
      ? "all GO"
      : `${verdicts.length} GO`
    : (["GO", "NO-GO", "PENDING", "SKIPPED"] as const)
        .filter((v) => count(v) > 0)
        .map((v) => `${count(v)} ${v}`)
        .join(" · ");
  const tone: RowTone = count("NO-GO") > 0 ? "error" : allGo ? "success" : "warning";
  const recorded = item.events.map(recordedOf).find((l) => l !== undefined);
  return {
    icon: "checks",
    title: verdicts.length === 1 ? `Check${revision !== undefined ? ` · design r${revision}` : ""}` : `Checks${revision !== undefined ? ` · design r${revision}` : ""}`,
    status,
    tone,
    details: item.events.map((e) => e.text),
    view: "checks",
    revision,
    ...(recorded ? { recorded } : {}),
  };
}

function stepsRow(item: TimelineItem): RowModel {
  const steps = item.events.flatMap((e) => (isRecord(e.data) && typeof e.data.n === "number" ? [e.data.n] : []));
  const channels = [...new Set(item.events.map((e) => e.channel))];
  const where = channels.length === 1 && channels[0] !== "web" && channels[0] !== "system" ? ` (from ${channelName(channels[0])})` : "";
  const label = steps.length === 0 ? "Build step done" : steps.length === 1 ? `Step ${steps[0]} done` : `Steps ${numberRanges(steps)} done`;
  return {
    icon: "steps",
    title: `${label}${where}`,
    tone: "success",
    details: item.events.map((e) => e.text),
    view: "steps",
    revision: item.events[0].revision,
  };
}

function benchRow(event: TimelineEvent): RowModel {
  const data = isRecord(event.data) ? event.data : {};
  const verdict = typeof data.verdict === "string" ? data.verdict : undefined;
  const virtual = typeof data.runId === "string" && data.runId.startsWith("virtual-");
  const kind = data.kind === "rails" ? "power check" : data.kind === "checkpoint" ? "checkpoint" : "self-test";
  const board = virtual ? "Virtual board" : "Your board";
  const passed = verdict === "pass";
  return {
    icon: "bench",
    title: `${board} · ${kind}${virtual ? " (practice)" : ""}`,
    status: passed ? "passed" : verdict === "fail" ? "found a problem" : "incomplete",
    tone: passed ? "success" : verdict === "fail" ? "error" : "warning",
    details: [event.text],
    view: passed ? "telemetry" : "diagnosis",
    revision: event.revision,
  };
}

function photoRow(event: TimelineEvent): RowModel {
  const data = isRecord(event.data) ? event.data : {};
  const step = typeof data.step === "number" ? data.step : undefined;
  const summary = typeof data.summary === "string" ? data.summary : undefined;
  const example = isRecord(data.recordedExample);
  return {
    icon: "photo",
    title: `Photo check${step !== undefined ? ` · step ${step}` : ""}`,
    ...(summary ? { status: summary.length > 60 ? `${summary.slice(0, 57)}…` : summary } : {}),
    tone: example ? "warning" : "info",
    details: [summary ?? event.text, ...(example ? ["Claude isn't connected, so this shows a recorded example, not your photo."] : [])],
    view: "photos",
    revision: event.revision,
  };
}

function singleRow(event: TimelineEvent): RowModel {
  const recorded = recordedOf(event);
  const base = { details: [event.text], revision: event.revision, ...(recorded ? { recorded } : {}) };
  switch (event.kind) {
    case "revision.created": {
      const tests = /independent (simulation )?tests/i.test(event.text);
      const note = event.text.replace(/^Revision \d+:\s*/, "").replace(/\s*\(Recorded run[^)]*\)$/, "");
      return {
        ...base,
        icon: tests ? "tests" : "design",
        title: tests ? `Tests written · design r${event.revision}` : `Design r${event.revision}${note && !/^revision \d+ with/i.test(note) ? ` · ${note}` : ""}`,
        status: event.actor.kind === "system" ? "prepared ahead of time" : whoDid(event),
        tone: "neutral",
        view: tests ? "tests" : "schematic",
      };
    }
    case "revision.released":
      return { ...base, icon: "go", title: `GO for build · design r${event.revision}`, status: whoDid(event), tone: "success", view: "steps" };
    case "release.review-recorded":
      return { ...base, icon: "go", title: "Released with a recorded independent review", tone: "info", view: "checks" };
    case "release.review-waived":
      return { ...base, icon: "go", title: "Released without the independent review", tone: "warning", view: "checks" };
    case "bench.run":
      return benchRow(event);
    case "photo.checked":
      return photoRow(event);
    case "bench.request.started":
      return { ...base, icon: "bench", title: "Bench action started", status: whoDid(event), tone: "info", view: "telemetry" };
    case "bench.request.denied":
      return { ...base, icon: "bench", title: "Bench action declined", tone: "warning", view: "telemetry" };
    case "inventory.added":
      return { ...base, icon: "parts", title: event.text.replace(/\.$/, ""), tone: "neutral", view: "parts" };
    case "mission.recorded":
      return { ...base, icon: "recorded", title: "Recorded run — replayed, not live", tone: "info" };
    case "mission.confirmed":
      return { ...base, icon: "done", title: "Mission complete — you confirmed it works", tone: "success" };
    case "phase.changed": {
      const type = phaseEventType(event);
      const view: PanelView | undefined =
        type === "DESIGN_READY" ? "checks" : type === "BUILD_DONE" ? "steps" : type === "VERIFY_FAILED" ? "diagnosis" : type === "FIX_PROPOSED" ? "schematic" : undefined;
      const tone: RowTone = type === "VERIFY_FAILED" ? "error" : type === "DESIGN_READY" || type === "BUILD_DONE" ? "success" : "info";
      const title =
        type === "DESIGN_READY" ? `Design r${event.revision} is ready for GO for build` : type === "BUILD_DONE" ? "All build steps done — test on the bench" : event.text;
      return { ...base, icon: "phase", title, tone, ...(view ? { view } : {}) };
    }
    default:
      return { ...base, icon: "info", title: event.text, tone: "neutral" };
  }
}

export function describeItem(item: TimelineItem): RowModel {
  if (item.group === "checks") return checksRow(item);
  if (item.group === "steps") return stepsRow(item);
  return singleRow(item.events[0]);
}
