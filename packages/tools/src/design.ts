import { CONSOLE_LABELS, hashJson, type Actor, type Circuit, type ConsoleReport, type Mission, type MissionStore, type Revision, type TestSuite } from "@vibread/core";
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

/**
 * Design-revision operations shared by the tools (propose_design, run_scenarios) and the human release route.
 * Suites written by the independent test author are cached by (brief, design interface) — what the author sees — so a
 * suite written for a read-only run is the same suite a later revision records, and is never paid for twice.
 */
export interface DesignOps {
  /** The suite for this circuit's interface: cached, else written now. Throws TestsNotWrittenError without a credential. */
  suiteFor(mission: Mission, circuit: Circuit, signal?: AbortSignal): Promise<TestSuite>;
  /** Pipeline + RETRO + onEvaluated for one revision. */
  evaluate(mission: Mission, n: number, signal?: AbortSignal): Promise<Revision>;
  /** Records a suite for a revision that has none as revision n+1 (same circuit), then evaluates it. */
  recordSuite(mission: Mission, revision: Revision, suite: TestSuite): Promise<Revision>;
}

export function createDesignOps(deps: { store: MissionStore; pipeline: Pipeline; hooks?: RegistryHooks }): DesignOps {
  const { store, pipeline, hooks = {} } = deps;
  const suites = new Map<string, TestSuite>();

  const ops: DesignOps = {
    async suiteFor(mission, circuit, signal) {
      const design = circuitInterface(circuit);
      const key = hashJson({ brief: mission.brief, design });
      const cached = suites.get(key);
      if (cached) return cached;
      if (!hooks.writeTests) throw new ToolInputError("No independent test author is configured.");
      const { coverageOf } = await import("@vibread/sim");
      try {
        const suite = await hooks.writeTests({
          missionId: mission.id,
          brief: mission.brief,
          design,
          coverageGaps: (candidate) => coverageOf(circuit, candidate).missing,
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
  };
  return ops;
}
