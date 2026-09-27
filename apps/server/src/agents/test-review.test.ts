import type { Actor, Scenario } from "@vibread/core";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { mockModels, scriptedDesign, scriptedJson, testDeps, type ScriptStep } from "./testing.js";
import { CORRECTED, NAIVE_SUITE, WHACK_A_MOLE, WHACK_A_MOLE_INVENTORY } from "./whack-a-mole.fixture.js";

/**
 * GitHub issue #16: simulation tests that contradict the intent must not count against a design that does what the intent
 * says. The tester's whack-a-mole (real compile + simulator): the test author's first suite stacks expect-part windows as
 * if they were simultaneous (T1, T2 fail although the firmware is right). The test review corrects them or ViBread sets
 * them aside (warnings only); it never becomes a design NO-GO that sends the agent into rewriting the sketch.
 */

const HUMAN: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const BRIEF = "make a whack a mole game with three buttons and three leds indicating when to press them";
const GO_VOTE = { verdict: "GO", summary: "The game does what was asked.", reasons: ["Fixed mole order", "Press edges debounced"], concerns: [] };
const propose: ScriptStep = { toolCalls: [{ name: "propose_design", input: { circuit: WHACK_A_MOLE, note: "Whack-a-mole" } }] };
type Review = { id: string; verdict: "test-wrong" | "design-wrong" | "unsure"; reason: string; scenario?: Scenario };
const corrected = (id: string) => CORRECTED.find((s) => s.id === id)!;
const STACKED = "Consecutive expect-part windows advance time; the wait assumed they were simultaneous, so the check lands after the light correctly came on.";

/** A mission whose test writer returns `suite`, whose reviewer answers `reviews(call)`, and whose RETRO votes GO. */
async function run(design: ScriptStep[], reviews: (call: number) => Review[], suite: (call: number) => unknown = () => NAIVE_SUITE) {
  const deps = testDeps();
  let reviewCalls = 0;
  let authorCalls = 0;
  const fast = scriptedJson((context: TranscriptContext) => {
    const text = JSON.stringify(context.messages);
    if (text.includes("You are RETRO")) return GO_VOTE;
    if (text.includes("reviewing your own simulation tests")) return { reviews: reviews(reviewCalls++) };
    return suite(authorCalls++);
  });
  const runtime = createAgentRuntime({ ...deps, models: mockModels(scriptedDesign(design), fast) });
  const mission = await runtime.missions.create({ brief: BRIEF, inventory: WHACK_A_MOLE_INVENTORY, owner: HUMAN });
  await runtime.missions.say(mission.id, BRIEF, HUMAN);
  const reply = (await deps.messages.list(mission.id)).findLast((m) => m.role === "assistant")!;
  const outputs = reply.parts.flatMap((p) => ("output" in p && p.state === "output-available" ? [{ tool: p.type.slice(5), output: p.output as ToolOutput }] : []));
  return { deps, runtime, mission, fast, outputs, reply, revisions: await deps.store.listRevisions(mission.id), reviewCalls: () => reviewCalls };
}

interface ToolOutput {
  summary: string;
  revision: number;
  verdicts: Record<string, string>;
  findings: { ruleId: string; severity: string; detail?: string; title: string }[];
  testReview?: { scenario: string; verdict: string; corrected?: boolean; setAside?: boolean }[];
}

describe("independent tests that contradict the intent (issue #16, whack-a-mole)", () => {
  it("the review corrects the stacked-window tests and the unchanged design passes (FIDO GO, same sketch)", async () => {
    const { outputs, revisions, deps, mission } = await run([propose, { text: "Done." }], () => [
      { id: "T1", verdict: "test-wrong", reason: STACKED, scenario: corrected("T1") },
      { id: "T2", verdict: "test-wrong", reason: STACKED, scenario: corrected("T2") },
    ]);
    const result = outputs.find((o) => o.tool === "propose_design")!.output;

    expect(result.verdicts).toMatchObject({ EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO" });
    expect(result.revision).toBe(2);
    expect(result.summary).toContain("The test author corrected T1, T2");
    expect(result.testReview).toEqual([expect.objectContaining({ scenario: "T1", verdict: "test-wrong", corrected: true }), expect.objectContaining({ scenario: "T2", verdict: "test-wrong", corrected: true })]);
    // Revision 1: the design with the naive suite (FIDO NO-GO); revision 2: the same circuit with the corrected tests.
    expect(revisions.map((r) => [r.n, r.results.reports.find((c) => c.console === "FIDO")?.verdict])).toEqual([[1, "NO-GO"], [2, "GO"]]);
    expect(revisions[1]!.circuit).toEqual(revisions[0]!.circuit);
    expect(revisions[1]!.circuit.sketch.source).toBe(WHACK_A_MOLE.sketch.source);
    expect(revisions[1]!.suite?.scenarios.find((s) => s.id === "T1")).toEqual(corrected("T1"));
    const reviewLog = deps.debug.entries.find((e) => e.missionId === mission.id && e.message.startsWith("test review:"));
    expect(reviewLog?.message).toBe("test review: T1 test-wrong, T2 test-wrong");
  }, 180_000);

  it("tests the review judges wrong without a working correction are set aside: FIDO GO, and they stay set aside on re-evaluation", async () => {
    const { outputs, revisions, runtime, deps, mission } = await run([propose, { text: "Done." }], () => [
      // No correction offered for T1; T2's "correction" is the same broken scenario.
      { id: "T1", verdict: "test-wrong", reason: STACKED },
      { id: "T2", verdict: "test-wrong", reason: STACKED, scenario: NAIVE_SUITE.scenarios.find((s) => s.id === "T2")! },
    ]);
    const result = outputs.find((o) => o.tool === "propose_design")!.output;

    expect(result.verdicts).toMatchObject({ EECOM: "GO", GUIDO: "GO", FIDO: "GO", FAO: "GO" });
    expect(result.findings.filter((f) => f.ruleId === "SIM-FAIL")).toEqual([]);
    const aside = result.findings.filter((f) => f.ruleId === "TEST-SET-ASIDE");
    expect(aside.map((f) => [f.severity, f.title])).toEqual([
      ["warning", "T1 set aside: the test review judged it wrong for the intent"],
      ["warning", "T2 set aside: the test review judged it wrong for the intent"],
    ]);
    // The failure still shows, with the reviewer's reason: the test really fails, it just doesn't block.
    expect(aside[0]!.detail).toContain("t=1050–1100 ms");
    expect(aside[0]!.detail).toContain(STACKED);
    expect(result.testReview?.map((r) => [r.scenario, r.setAside])).toEqual([["T1", true], ["T2", true]]);
    expect(result.summary).toContain("ViBread set aside T1, T2");
    // r1 naive suite; r2 T1 set aside + T2 "corrected"; r3 T2's failing correction set aside too. The sketch never changed.
    expect(revisions.map((r) => [r.n, r.results.reports.find((c) => c.console === "FIDO")?.verdict])).toEqual([[1, "NO-GO"], [2, "NO-GO"], [3, "GO"]]);
    expect(revisions.every((r) => r.circuit.sketch.source === WHACK_A_MOLE.sketch.source)).toBe(true);
    expect(revisions[2]!.suite!.scenarios.filter((s) => s.setAside).map((s) => s.id)).toEqual(["T1", "T2"]);

    // Re-running the pipeline (a re-check, a server restart) keeps them set aside: it's in the suite, not the report.
    await runtime.pipeline.evaluate(mission.id, 3);
    const fido = (await deps.store.getRevision(mission.id, 3))!.results.reports.find((r) => r.console === "FIDO")!;
    expect(fido.verdict).toBe("GO");
    expect(fido.findings.map((f) => [f.ruleId, f.severity])).toEqual([["TEST-SET-ASIDE", "warning"], ["TEST-SET-ASIDE", "warning"]]);
  }, 180_000);

  it("tests the review confirms stay design findings, with the reviewer's reason and a pointer to dispute_test", async () => {
    const { outputs, revisions } = await run([propose, { text: "Done." }], () => [
      { id: "T1", verdict: "design-wrong", reason: "C1 says red lights at 1 s; checked at 1.05 s it was on." },
      { id: "T2", verdict: "unsure", reason: "The intent doesn't say when the gap starts." },
    ]);
    const result = outputs.find((o) => o.tool === "propose_design")!.output;

    expect(revisions).toHaveLength(1);
    expect(result.findings.filter((f) => f.ruleId === "SIM-FAIL").map((f) => f.detail)).toEqual([
      expect.stringContaining("The test reviewer confirmed this test matches the intent: C1 says red"),
      expect.stringContaining("The test reviewer couldn't tell whether the test or the design is wrong"),
    ]);
    expect(result.summary).toContain("call dispute_test — never remove or change user-visible behavior just to pass a test");
  }, 180_000);

  it("the design agent can dispute a failing test instead of changing the design; the corrected tests pass", async () => {
    const dispute: ScriptStep = { toolCalls: [{ name: "dispute_test", input: { revision: 1, scenarios: ["T1", "T2"], reason: "C1 fixes red at 1 s; the test checks at 1.05 s because its three off-windows moved the clock." } }] };
    const { outputs, revisions, reviewCalls, fast } = await run([propose, dispute, { text: "The tests were wrong; the game passes." }], (call) =>
      call === 0
        ? [{ id: "T1", verdict: "unsure", reason: "Can't tell." }, { id: "T2", verdict: "unsure", reason: "Can't tell." }]
        : [
            { id: "T1", verdict: "test-wrong", reason: STACKED, scenario: corrected("T1") },
            { id: "T2", verdict: "test-wrong", reason: STACKED, scenario: corrected("T2") },
          ],
    );
    expect(reviewCalls()).toBe(2);
    expect(fast.requests.filter((r) => JSON.stringify(r.messages).includes("The design agent disputes these tests"))).toHaveLength(1);
    const disputed = outputs.find((o) => o.tool === "dispute_test")!.output;
    expect(disputed.verdicts.FIDO).toBe("GO");
    expect(disputed.revision).toBe(2);
    expect(revisions.map((r) => r.circuit.sketch.source === WHACK_A_MOLE.sketch.source)).toEqual([true, true]);
  }, 180_000);

  it("a disputed test the reviewer is unsure about is set aside; one it confirms keeps blocking", async () => {
    const dispute: ScriptStep = { toolCalls: [{ name: "dispute_test", input: { revision: 1, scenarios: ["T1", "T2"], reason: "C1 fixes red at 1 s; the test checks at 1.05 s because its three off-windows moved the clock." } }] };
    const { outputs, revisions } = await run([propose, dispute, { text: "Done." }], (call) =>
      call === 0
        ? [{ id: "T1", verdict: "unsure", reason: "Can't tell." }, { id: "T2", verdict: "unsure", reason: "Can't tell." }]
        : [{ id: "T1", verdict: "unsure", reason: "The intent doesn't say when the gap starts." }, { id: "T2", verdict: "design-wrong", reason: "C1 says red lights at 1 s; checked at 1.05 s it was on." }],
    );
    // Without a dispute, "unsure" alone doesn't set a test aside.
    const proposed = outputs.find((o) => o.tool === "propose_design")!.output;
    expect(proposed.findings.filter((f) => f.ruleId === "SIM-FAIL").map((f) => f.title.split(":")[0])).toEqual(["T1", "T2"]);
    const disputed = outputs.find((o) => o.tool === "dispute_test")!.output;
    expect(disputed.verdicts.FIDO).toBe("NO-GO");
    expect(disputed.findings.filter((f) => f.ruleId === "TEST-SET-ASIDE").map((f) => [f.title.split(" ")[0], f.severity])).toEqual([["T1", "warning"]]);
    const blocking = disputed.findings.filter((f) => f.ruleId === "SIM-FAIL");
    expect(blocking.map((f) => f.title.split(":")[0])).toEqual(["T2"]);
    expect(blocking[0]!.detail).toContain("The test reviewer confirmed this test matches the intent");
    expect(revisions.at(-1)!.suite!.scenarios.find((s) => s.id === "T1")!.setAside).toContain("The design agent disputed it");
    expect(revisions.at(-1)!.suite!.scenarios.find((s) => s.id === "T2")!.setAside).toBeUndefined();
  }, 180_000);

  it("a later revision keeps the scenarios of unchanged clauses; the author writes only for the changed clause", async () => {
    const changed = { ...WHACK_A_MOLE, intent: WHACK_A_MOLE.intent.map((c) => (c.id === "C4" ? { ...c, text: "Each press counts once, even a bouncy press; presses between moles are ignored." } : c)) };
    const second: ScriptStep = { toolCalls: [{ name: "propose_design", input: { circuit: changed, note: "Clarify C4" } }] };
    const newC4: Scenario = { id: "T1", title: "A bouncy press on mole 1 counts once", clauses: ["C4"], categories: ["bounce"], setup: {}, steps: [{ wait: 1100 }, { bounce: { part: "BTN1", to: true, edges: 6, ms: 8 } }, { wait: 100 }, { "expect-part": { part: "LED1", state: "off", windowMs: 50 } }] };
    const suites = [{ ...NAIVE_SUITE, scenarios: NAIVE_SUITE.scenarios.map((s) => corrected(s.id) ?? s) }, { scenarios: [newC4, { ...newC4, id: "T2", title: "Quick taps count once", categories: ["rapid"], steps: [{ press: { part: "BTN3", holdMs: 40, gapMs: 40 } }, { press: { part: "BTN3", holdMs: 40, gapMs: 40 } }, { "expect-part": { part: "LED3", state: "off", windowMs: 50 } }] }] }];
    const { revisions, fast } = await run([propose, second, { text: "Done." }], () => [], (call) => suites[Math.min(call, 1)]);
    const authorRequests = fast.requests.filter((r) => JSON.stringify(r.messages).includes("independent test author") && !JSON.stringify(r.messages).includes("reviewing"));
    expect(authorRequests).toHaveLength(2);
    const second_prompt = JSON.stringify(authorRequests[1]!.messages);
    expect(second_prompt).toContain("stay exactly as they are");
    expect(second_prompt).toContain("Write scenarios ONLY for these intent clauses: C4");
    const kept = revisions.at(-1)!.suite!.scenarios;
    // T1–T4 (clauses C1–C3 unchanged) are carried over verbatim; the new C4 scenarios are renumbered after them.
    expect(kept.slice(0, 4)).toEqual(revisions[0]!.suite!.scenarios.filter((s) => !s.clauses.includes("C4")));
    expect(kept.slice(4).map((s) => [s.id, s.clauses])).toEqual([["T5", ["C4"]], ["T6", ["C4"]]]);
    expect(revisions.at(-1)!.results.reports.find((r) => r.console === "FIDO")?.verdict).toBe("GO");
  }, 180_000);

  it("with placement groups, the placement summary of what was really built reaches the design agent", async () => {
    const grouped = { ...WHACK_A_MOLE, placement: { groups: [["BTN1", "LED1", "R1"], ["BTN2", "LED2", "R2"], ["BTN3", "LED3", "R3"]] } };
    const proposeGrouped: ScriptStep = { toolCalls: [{ name: "propose_design", input: { circuit: grouped, note: "Lights next to their buttons" } }] };
    const { outputs } = await run([proposeGrouped, { text: "Done." }], () => [], () => ({ ...NAIVE_SUITE, scenarios: NAIVE_SUITE.scenarios.map((s) => corrected(s.id) ?? s) }));
    const result = outputs.find((o) => o.tool === "propose_design")!.output as ToolOutput & { placement?: string };
    expect(result.placement).toContain("Group BTN1+LED1+R1");
    expect(result.placement).toContain("Group BTN3+LED3+R3");
    expect(result.findings.filter((f) => f.ruleId === "PLACEMENT-UNMET")).toEqual([]);
  }, 180_000);
});
