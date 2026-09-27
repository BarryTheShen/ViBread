import { CONSOLE_LABELS, ScenarioSchema, hashJson, type Actor, type Circuit, type ConsoleReport, type Finding, type Mission, type MissionStore, type Revision, type Scenario, type TestSuite } from "@vibread/core";
import { ToolInputError, circuitInterface, crashFinding, deterministicGo, errorMessage, isClaudeNotConnected, requireRevision, statusReport } from "./common.js";
import type { Pipeline } from "./pipeline.js";
import type { RegistryHooks } from "./registry.js";

/**
 * RETRO for one revision (PLAN §5.4): PENDING until EECOM/GUIDO/FIDO/FAO are GO; SKIPPED when no reviewer or Claude isn't
 * connected; a reviewer crash is NO-GO. Replaces the revision's RETRO report and records a timeline event.
 */
export async function reviewRevision(input: {
  store: MissionStore;
  mission: Mission;
  n: number;
  review?: RegistryHooks["review"];
  signal?: AbortSignal;
}): Promise<Revision> {
  const { store, mission, n, review, signal } = input;
  const revision = await requireRevision(store, mission.id, n);
  let retro: ConsoleReport;
  if (!deterministicGo(revision.results.reports)) {
    retro = statusReport("RETRO", "PENDING", "The independent review runs once every other console is GO.", revision.hash);
  } else if (!review) {
    retro = statusReport("RETRO", "SKIPPED", "No independent reviewer is configured.", revision.hash);
  } else {
    try {
      retro = await review({ mission, revision, ...(signal ? { signal } : {}) });
    } catch (error) {
      retro = isClaudeNotConnected(error)
        ? statusReport("RETRO", "SKIPPED", errorMessage(error), revision.hash)
        : { ...statusReport("RETRO", "PENDING", "The independent review failed.", revision.hash), verdict: "NO-GO", findings: [crashFinding("RETRO", "independent review", error)] };
    }
  }
  const saved = await store.saveResults(mission.id, n, { reports: [...revision.results.reports.filter((r) => r.console !== "RETRO"), retro] });
  await store.appendEvent({
    missionId: mission.id,
    channel: "system",
    actor: { kind: "agent", id: "retro", name: "RETRO reviewer", channel: "system" },
    kind: "console.report",
    text: `${CONSOLE_LABELS.RETRO} (RETRO): ${retro.verdict} — ${retro.summary}`,
    revision: n,
    data: { console: "RETRO", verdict: retro.verdict, reasons: retro.evidence?.reasons },
  });
  return saved;
}

const TEST_AUTHOR: Actor = { kind: "agent", id: "test-author", name: "Independent test author", channel: "system" };

/** Thrown when tests are needed but no credential can run the test author; `code` lets callers phrase it for their UI. */
export class TestsNotWrittenError extends ToolInputError {
  constructor() {
    super("The simulation tests haven't been written yet because Claude isn't connected.", 409);
    Object.assign(this, { code: "tests_missing" });
  }
}

/** One failing scenario the test reviewer judged (RegistryHooks.reviewTests). */
export interface TestReview {
  id: string;
  verdict: "test-wrong" | "design-wrong" | "unsure";
  reason: string;
  /** The corrected scenario (same id) for "test-wrong". */
  scenario?: Scenario;
}

/** What the review of a revision's failing tests did. */
export interface ReviewOutcome {
  /** The revision to report: `revision` itself, or a later one (same circuit) with the corrected or set-aside suite, already evaluated. */
  revision: Revision;
  reviews: TestReview[];
  /** Scenario ids replaced by corrected ones (and still passing or not failing any more). */
  corrected: string[];
  /** Scenario ids set aside: judged wrong without a working correction, or disputed and not confirmed. They only warn. */
  setAside: string[];
}

/** Hardware the tests drive and watch: part ids + kinds and pin roles (labels, order and values don't change a test). */
function hardwareKey(circuit: Circuit): string {
  const parts = circuit.parts.map((p) => `${p.id}:${p.module}`).sort();
  const roles = circuit.roles.map((r) => `${r.pin}:${r.mode}:${r.part}`).sort();
  return hashJson({ board: circuit.board.profile, parts, roles });
}

/**
 * Which scenarios of the previous suite still apply to `circuit`: with the same hardware, every scenario whose clauses all
 * still exist with the same text is kept (passing or not — a correct test that fails must stay until the design passes
 * it); `clauses` are the intent clauses new or changed since, which need new scenarios. Undefined when the hardware
 * changed (the whole suite is rewritten).
 */
export function carryForward(previous: { circuit: Circuit; suite: TestSuite }, circuit: Circuit): { keep: Scenario[]; clauses: string[] } | undefined {
  if (hardwareKey(previous.circuit) !== hardwareKey(circuit)) return undefined;
  const before = new Map(previous.circuit.intent.map((c) => [c.id, c.text.trim()]));
  const now = new Map(circuit.intent.map((c) => [c.id, c.text.trim()]));
  const keep = previous.suite.scenarios.filter((s) => s.clauses.every((id) => now.has(id) && now.get(id) === before.get(id)));
  const covered = new Set(keep.flatMap((s) => s.clauses));
  const clauses = circuit.intent.filter((c) => before.get(c.id) !== c.text.trim() || !covered.has(c.id)).map((c) => c.id);
  return { keep, clauses };
}

/**
 * Design-revision operations shared by the tools (propose_design, run_scenarios, dispute_test) and the human release
 * route. Suites written by the independent test author are cached by (brief, design interface) — what the author sees — so
 * a suite written for a read-only run is the same suite a later revision records, and is never paid for twice.
 */
export interface DesignOps {
  /**
   * The suite for this circuit: cached; else, with `previous`, the previous suite's scenarios that still apply plus new
   * ones for changed clauses only (carryForward); else written now. Throws TestsNotWrittenError without a credential.
   */
  suiteFor(mission: Mission, circuit: Circuit, signal?: AbortSignal, previous?: Revision | null): Promise<TestSuite>;
  /** Pipeline + RETRO + onEvaluated for one revision. */
  evaluate(mission: Mission, n: number, signal?: AbortSignal): Promise<Revision>;
  /** Records a suite for a revision that has none as revision n+1 (same circuit), then evaluates it. */
  recordSuite(mission: Mission, revision: Revision, suite: TestSuite): Promise<Revision>;
  /**
   * When simulation tests failed, the test author reviews them against the intent (never the sketch): scenarios that
   * contradict the intent are corrected and re-run as revision n+1 (same circuit). Ones judged wrong without a working
   * correction are set aside (recorded in the suite, so FIDO keeps reporting them as warnings only), and so are disputed
   * ones the reviewer can't confirm ("unsure" with `dispute`). Only tests the reviewer confirms stay SIM-FAIL (blocking),
   * with its reason. `only`/`dispute`: the design agent's dispute.
   */
  reviewFailedTests(mission: Mission, revision: Revision, options?: { signal?: AbortSignal; only?: string[]; dispute?: string }): Promise<ReviewOutcome>;
}

export function createDesignOps(deps: { store: MissionStore; pipeline: Pipeline; hooks?: RegistryHooks }): DesignOps {
  const { store, pipeline, hooks = {} } = deps;
  const suites = new Map<string, TestSuite>();

  async function recordCorrectedSuite(mission: Mission, revision: Revision, suite: TestSuite, note: string): Promise<Revision> {
    const next = await store.createRevision(mission.id, { circuit: revision.circuit, suite, author: TEST_AUTHOR, note, parent: revision.n });
    await store.updateMission(mission.id, { currentRevision: next.n });
    await store.appendEvent({ missionId: mission.id, channel: "system", actor: TEST_AUTHOR, kind: "revision.created", text: `Revision ${next.n}: ${note}`, revision: next.n, data: { hash: next.hash, parent: revision.n } });
    // Proposing the same design again gets the reviewed suite, not the one before the review.
    const key = hashJson({ brief: mission.brief, design: circuitInterface(revision.circuit) });
    if (suites.has(key)) suites.set(key, suite);
    return next;
  }

  const ops: DesignOps = {
    async suiteFor(mission, circuit, signal, previous) {
      const design = circuitInterface(circuit);
      const key = hashJson({ brief: mission.brief, design });
      const cached = suites.get(key);
      if (cached) return cached;
      const { coverageOf } = await import("@vibread/sim");
      const plan = previous?.suite ? carryForward({ circuit: previous.circuit, suite: previous.suite }, circuit) : undefined;
      if (plan && plan.clauses.length === 0 && plan.keep.length > 0) {
        const kept: TestSuite = { ...previous!.suite!, scenarios: plan.keep };
        if (coverageOf(circuit, kept).missing.length === 0) {
          suites.set(key, kept);
          return kept;
        }
      }
      if (!hooks.writeTests) throw new ToolInputError("No independent test author is configured.");
      try {
        const suite = await hooks.writeTests({
          missionId: mission.id,
          brief: mission.brief,
          design,
          coverageGaps: (candidate) => coverageOf(circuit, candidate).missing,
          ...(plan?.keep.length ? { keep: plan.keep, clauses: plan.clauses } : {}),
          ...(signal ? { signal } : {}),
        });
        // A suite with coverage gaps isn't kept: the next proposal asks the author again instead of reusing its gaps.
        if (coverageOf(circuit, suite).missing.length === 0) suites.set(key, suite);
        return suite;
      } catch (error) {
        if (isClaudeNotConnected(error)) throw new TestsNotWrittenError();
        throw error;
      }
    },

    async evaluate(mission, n, signal) {
      await pipeline.evaluate(mission.id, n);
      const revision = await reviewRevision({ store, mission, n, ...(hooks.review ? { review: hooks.review } : {}), ...(signal ? { signal } : {}) });
      await hooks.onEvaluated?.(mission.id, revision);
      return revision;
    },

    async recordSuite(mission, revision, suite) {
      const next = await store.createRevision(mission.id, { circuit: revision.circuit, suite, author: TEST_AUTHOR, note: `Independent tests added to revision ${revision.n}`, parent: revision.n });
      await store.updateMission(mission.id, { currentRevision: next.n });
      await store.appendEvent({
        missionId: mission.id,
        channel: "system",
        actor: TEST_AUTHOR,
        kind: "revision.created",
        text: `Revision ${next.n}: revision ${revision.n} with its independent simulation tests (${suite.scenarios.length}).`,
        revision: next.n,
        data: { hash: next.hash, parent: revision.n },
      });
      return ops.evaluate(mission, next.n);
    },

    async reviewFailedTests(mission, revision, options = {}) {
      const unchanged: ReviewOutcome = { revision, reviews: [], corrected: [], setAside: [] };
      const suite = revision.suite;
      if (!hooks.reviewTests || !suite || suite.author !== "test-author") return unchanged;
      const failing = failingScenarios(revision).filter((f) => !options.only || options.only.includes(f.id));
      const failures = failing.flatMap((f) => {
        const scenario = suite.scenarios.find((s) => s.id === f.id);
        return scenario ? [{ scenario, detail: f.detail }] : [];
      });
      if (!failures.length) return unchanged;
      const reviews = await hooks.reviewTests({
        missionId: mission.id,
        brief: mission.brief,
        design: circuitInterface(revision.circuit),
        failures,
        ...(options.dispute ? { dispute: options.dispute } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const judged = reviews.filter((r) => failures.some((f) => f.scenario.id === r.id));
      if (!judged.length) return unchanged;
      const byId = new Map(judged.map((r) => [r.id, r]));
      const repairs = new Map<string, Scenario>();
      const aside = new Map<string, string>();
      const markAside = (s: Scenario): Scenario => (aside.has(s.id) ? { ...s, setAside: aside.get(s.id)! } : s);
      for (const review of judged) {
        // The reviewer's correction can't set itself aside (omit strips the key).
        const parsed = review.verdict === "test-wrong" && review.scenario ? ScenarioSchema.omit({ setAside: true }).safeParse({ ...review.scenario, id: review.id }) : undefined;
        if (parsed?.success) repairs.set(review.id, parsed.data);
        else if (review.verdict === "test-wrong") aside.set(review.id, `The test reviewer judged it wrong for the intent: ${review.reason}`);
        // Two independent calls (the design agent's dispute and an unsure reviewer) don't confirm the test.
        else if (review.verdict === "unsure" && options.dispute) aside.set(review.id, `The design agent disputed it and the test reviewer couldn't confirm it matches the intent: ${review.reason}`);
      }

      let final = revision;
      if (repairs.size || aside.size) {
        const reviewed: TestSuite = { ...suite, scenarios: suite.scenarios.map((s) => repairs.get(s.id) ?? markAside(s)) };
        const notes = [
          ...(repairs.size ? [`corrected independent tests (${[...repairs.keys()].join(", ")}): they contradicted the intent, not the design`] : []),
          ...(aside.size ? [`set aside independent tests (${[...aside.keys()].join(", ")}): the test review didn't confirm them`] : []),
        ];
        const next = await recordCorrectedSuite(mission, revision, reviewed, `revision ${revision.n} with ${notes.join("; ")}.`);
        final = await ops.evaluate(mission, next.n, options.signal);
      }

      // A correction that still fails is set aside too: the reviewer already judged the original wrong for the intent.
      const failedRepairs = failingScenarios(final).filter((f) => repairs.has(f.id));
      if (failedRepairs.length && final.suite) {
        for (const { id } of failedRepairs) {
          repairs.delete(id);
          aside.set(id, `The test reviewer judged the original wrong for the intent, and its correction still fails: ${byId.get(id)?.reason ?? ""}`);
        }
        const reviewed: TestSuite = { ...final.suite, scenarios: final.suite.scenarios.map(markAside) };
        const next = await recordCorrectedSuite(mission, final, reviewed, `revision ${final.n} with set-aside independent tests (${failedRepairs.map((f) => f.id).join(", ")}): their corrections still fail.`);
        final = await ops.evaluate(mission, next.n, options.signal);
      }

      // Tests the review kept (confirmed, or unsure without a dispute) stay SIM-FAIL with the reviewer's reason.
      const fido = final.results.reports.find((r) => r.console === "FIDO");
      if (fido && failingScenarios(final).some((f) => byId.has(f.id))) {
        const findings = fido.findings.map((finding): Finding => {
          const id = finding.ruleId === "SIM-FAIL" ? finding.refs?.scenarios?.[0] : undefined;
          const review = id ? byId.get(id) : undefined;
          if (!review) return finding;
          const note = review.verdict === "design-wrong" ? `The test reviewer confirmed this test matches the intent: ${review.reason}` : `The test reviewer couldn't tell whether the test or the design is wrong: ${review.reason}`;
          return { ...finding, detail: `${finding.detail ?? ""} — ${note}`.trim() };
        });
        final = await store.saveResults(mission.id, final.n, { reports: final.results.reports.map((r) => (r.console === "FIDO" ? { ...r, findings } : r)) });
      }
      await store.appendEvent({
        missionId: mission.id,
        channel: "system",
        actor: TEST_AUTHOR,
        kind: "tests.reviewed",
        text: `Test review of revision ${revision.n}: ${judged.map((r) => `${r.id} ${r.verdict}${repairs.has(r.id) ? " (corrected)" : aside.has(r.id) ? " (set aside)" : ""}`).join(", ") || "no verdict"}`,
        revision: final.n,
        data: { reviews: judged.map(({ scenario: _scenario, ...rest }) => rest), corrected: [...repairs.keys()], setAside: [...aside.keys()] },
      });
      return { revision: final, reviews: judged, corrected: [...repairs.keys()], setAside: [...aside.keys()] };
    },
  };
  return ops;
}

/** The failing scenarios of a revision's FIDO report, with the simulator's failure detail. */
function failingScenarios(revision: Revision): { id: string; detail: string }[] {
  const fido = revision.results.reports.find((r) => r.console === "FIDO");
  return (fido?.findings ?? []).flatMap((f) => (f.ruleId === "SIM-FAIL" && f.refs?.scenarios?.[0] ? [{ id: f.refs.scenarios[0], detail: f.detail ?? f.title }] : []));
}
