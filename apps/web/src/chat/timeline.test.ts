import type { RevisionSummary, TimelineEvent } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { describeItem, groupTimeline, placeTimeline, withRevisionEvents } from "./timeline.js";

let seq = 0;
function ev(kind: string, at: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    missionId: "m",
    at: new Date(Date.UTC(2026, 8, 26, 12, 0, at)).toISOString(),
    channel: "system",
    actor: { kind: "system", id: "server", channel: "system" },
    kind,
    text: `${kind} ${at}`,
    ...extra,
  };
}

const human = { kind: "human" as const, id: "u1", name: "Ada", channel: "web" as const };
const report = (at: number, revision: number, console: string, verdict: string) =>
  ev("console.report", at, { revision, data: { console, verdict }, text: `${console}: ${verdict}` });
const step = (at: number, n: number) => ev("build.step", at, { revision: 2, data: { n }, actor: human, channel: "web", text: `Step ${n} done` });

describe("groupTimeline", () => {
  it("groups check reports per revision and consecutive build steps, and hides noise and duplicate phase events", () => {
    const items = groupTimeline([
      ev("mission.created", 0),
      ev("phase.changed", 1, { data: { event: { type: "DESIGN_STARTED" } } }),
      report(2, 1, "EECOM", "GO"),
      report(3, 1, "GUIDO", "GO"),
      report(4, 2, "EECOM", "NO-GO"),
      ev("faults.ready", 5),
      step(6, 1),
      ev("phase.changed", 7, { data: { event: { type: "BUILD_STEP", n: 1 } } }),
      step(8, 2),
      step(9, 3),
      ev("photo.checked", 10, { revision: 2, data: { step: 3, summary: "LED3 looks right" } }),
      step(11, 5),
    ]);
    expect(items.map((i) => [i.group, i.events.length])).toEqual([
      ["checks", 2],
      ["checks", 1],
      ["steps", 3],
      [null, 1],
      ["steps", 1],
    ]);
    expect(describeItem(items[2]).title).toBe("Steps 1–3 done");
    expect(describeItem(items[0])).toMatchObject({ title: "Checks · design r1", view: "checks", revision: 1, tone: "success" });
    expect(describeItem(items[1])).toMatchObject({ status: "1 NO-GO", tone: "error" });
    expect(describeItem(items[3])).toMatchObject({ title: "Photo check · step 3", view: "photos" });
  });

  it("words gaps in step ranges and counts a console that reported twice once", () => {
    const [steps] = groupTimeline([step(1, 1), step(2, 2), step(3, 4)]);
    expect(describeItem(steps).title).toBe("Steps 1–2, 4 done");
    const [checks] = groupTimeline([
      report(1, 3, "EECOM", "GO"),
      report(2, 3, "GUIDO", "GO"),
      report(3, 3, "FIDO", "GO"),
      report(4, 3, "FAO", "GO"),
      report(5, 3, "RETRO", "PENDING"),
      report(6, 3, "RETRO", "GO"),
    ]);
    expect(describeItem(checks).status).toBe("all GO");
  });

  it("an older design's checks that never ran read 'not run (superseded)' in neutral tone; the latest design keeps waiting", () => {
    const [old] = groupTimeline([report(1, 1, "EECOM", "GO"), report(2, 1, "GUIDO", "GO"), report(3, 1, "FIDO", "PENDING"), report(4, 1, "RETRO", "PENDING")]);
    expect(describeItem(old, 2)).toMatchObject({ status: "2 GO · 2 not run (superseded)", tone: "neutral" });
    expect(describeItem(old, 2).details.at(-1)).toMatch(/^Not run — superseded by r2/);
    expect(describeItem(old, 1)).toMatchObject({ status: "2 GO · 2 PENDING", tone: "warning" });
    const [failed] = groupTimeline([report(1, 1, "EECOM", "NO-GO"), report(2, 1, "FIDO", "PENDING")]);
    expect(describeItem(failed, 3)).toMatchObject({ status: "1 NO-GO · 1 not run (superseded)", tone: "error" });
  });

  it("keeps a revision's reports in one row when 'ready for GO' is logged between them, but not a much later vote", () => {
    const ready = ev("phase.changed", 2, { revision: 1, data: { event: { type: "DESIGN_READY", revision: 1 } } });
    const items = groupTimeline([report(2, 1, "GUIDO", "GO"), ready, report(2, 1, "FAO", "GO"), report(900, 1, "RETRO", "SKIPPED")]);
    expect(items.map((i) => [i.events[0].kind, i.events.length])).toEqual([
      ["console.report", 2],
      ["phase.changed", 1],
      ["console.report", 1],
    ]);
  });

  it("opens the panel view that explains each event", () => {
    const views = groupTimeline([
      ev("revision.created", 1, { revision: 1, actor: { kind: "agent", id: "design-agent", channel: "web" }, text: "Revision 1: Moon lamp" }),
      ev("revision.created", 2, { revision: 2, text: "Revision 2: revision 1 with 8 independent simulation tests" }),
      ev("revision.released", 3, { revision: 2, actor: human, channel: "web" }),
      ev("bench.run", 4, { revision: 2, data: { runId: "virtual-1", kind: "selftest", verdict: "pass" } }),
      ev("bench.run", 5, { revision: 2, data: { runId: "r-2", kind: "selftest", verdict: "fail" } }),
      ev("phase.changed", 6, { revision: 2, data: { event: { type: "DESIGN_READY", revision: 2 } } }),
    ]).map(describeItem);
    expect(views.map((v) => v.view)).toEqual(["schematic", "tests", "steps", "telemetry", "diagnosis", "checks"]);
    expect(views[0]).toMatchObject({ title: "Design r1 · Moon lamp", status: "by Claude" });
    expect(views[2]).toMatchObject({ title: "GO for build · design r2", status: "by you" });
    expect(views[3]).toMatchObject({ title: "Virtual board · self-test (practice)", status: "passed" });
  });
});

describe("placeTimeline", () => {
  const brief = { id: "u-brief", role: "user" };
  const reply = { id: "a-1", role: "assistant" };
  const followUp = { id: "u-2", role: "user" };
  const reply2 = { id: "a-2", role: "assistant" };

  it("puts each turn's rows after Claude's reply, before the next message you sent", () => {
    const events = [
      ev("message", 10, { actor: human, channel: "web" }),
      ev("revision.created", 12, { revision: 1 }),
      report(13, 1, "EECOM", "GO"),
      ev("message", 14, { actor: { kind: "agent", id: "design-agent", channel: "web" } }),
      ev("message", 20, { actor: human, channel: "web" }),
      ev("revision.created", 22, { revision: 2 }),
    ];
    const placed = placeTimeline([brief, reply, followUp, reply2], events);
    expect(Object.keys(placed.before)).toEqual(["u-2"]);
    expect(placed.before["u-2"].map((i) => i.events[0].kind)).toEqual(["revision.created", "console.report"]);
    expect(placed.end.map((i) => i.events[0].revision)).toEqual([2]);
  });

  it("keeps rows above a message that was just sent and not logged by the server yet", () => {
    const events = [ev("message", 10, { actor: human, channel: "web" }), ev("revision.created", 12, { revision: 1 })];
    const placed = placeTimeline([brief, reply, followUp], events);
    expect(placed.before["u-2"]).toHaveLength(1);
    expect(placed.end).toEqual([]);
  });

  it("keeps a live run's new design below the answer that caused it while the timeline catches up, then in place", () => {
    // Answering Claude's question starts a run whose design lands in GET revisions before the next timeline poll logs
    // either the answer or the design's own event.
    const agent = { kind: "agent" as const, id: "design-agent", channel: "web" as const };
    const r1: RevisionSummary = { n: 1, hash: "h1", createdAt: new Date(Date.UTC(2026, 8, 26, 12, 0, 31)).toISOString(), author: agent, note: "First design", verdicts: {} };
    const answer = { id: "u-answer", role: "user" };
    const messages = [brief, reply, answer, reply2];
    const stale = [ev("message", 10, { actor: human, channel: "web" }), ev("message", 14, { actor: agent, channel: "web" })];
    const during = placeTimeline(messages, withRevisionEvents(stale, [r1], "m"));
    expect(during.before["u-answer"]).toBeUndefined();

    const caughtUp = [...stale, ev("message", 30, { actor: human, channel: "web" }), ev("revision.created", 32, { revision: 1, actor: agent })];
    const after = placeTimeline(messages, withRevisionEvents(caughtUp, [r1], "m"));
    expect(after.before["u-answer"]).toBeUndefined();
    expect(after.end.map((i) => i.events[0].revision)).toEqual([1]);
  });

  it("still adds a row for a pre-warmed design that the timeline never logged", () => {
    const golden = { kind: "system" as const, id: "golden-fixture", channel: "system" as const };
    const r1: RevisionSummary = { n: 1, hash: "h1", createdAt: new Date(Date.UTC(2026, 8, 26, 12, 0, 5)).toISOString(), author: golden, note: "Pre-warmed golden design", verdicts: {} };
    const events = withRevisionEvents([ev("mission.created", 1), report(6, 1, "EECOM", "GO")], [r1], "m");
    expect(placeTimeline([], events).end.map((i) => i.events[0].kind)).toEqual(["revision.created", "console.report"]);
  });

  it("tells the whole story after a recorded run's replayed brief, and with no chat at all", () => {
    const recorded = { id: "recorded-user", role: "user", metadata: { vibread: { recorded: { label: "Recorded run" } } } };
    const events = [ev("mission.recorded", 1, { data: { label: "Recorded run" } }), ev("revision.created", 2, { revision: 1 }), report(3, 1, "EECOM", "GO")];
    expect(placeTimeline([recorded, reply], events).end).toHaveLength(3);
    const alone = placeTimeline([], events);
    expect(alone.before).toEqual({});
    expect(describeItem(alone.end[0])).toMatchObject({ icon: "recorded", recorded: "Recorded run" });
  });
});
