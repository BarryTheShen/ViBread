import { setTimeout as sleep } from "node:timers/promises";
import { CONSOLE_LABELS, type ConsoleId, type MissionStore, type Revision, type Verdict } from "@vibread/core";
import { DETERMINISTIC_CONSOLES, SYSTEM_ACTOR, deterministicGo, errorMessage, statusReport, type Pipeline } from "@vibread/tools";
import type { Logger } from "pino";
import type { DebugLog } from "../services/debug-log.js";
import { BUILD_PROGRESS_EVENT, BUILD_STEP_EVENT, doneSteps, remapProgress, sameStepStructure } from "../services/build-progress.js";
import { WIRE_COLOR_EVENT } from "../services/wire-colors.js";

/** Longest a server shutdown waits for the revision being re-derived. */
const STOP_WAIT_MS = 15_000;

/** What one start-up refresh did. */
export interface RefreshSummary {
  version?: string;
  refreshed: { missionId: string; revision: number; keptLayout: boolean; verdictsChanged: boolean; progress?: { from: number; to: number } }[];
  failed: { missionId: string; revision: number; error: string }[];
  skipped: number;
  ms: number;
}

export interface DerivedRefresher {
  /** Re-derives every out-of-date current/released revision, one at a time (safe to call once, in the background). */
  run(): Promise<RefreshSummary>;
  /** Stops after the revision in progress (waits for it, up to 15 s). */
  stop(): Promise<void>;
}

function verdictsOf(revision: Revision): Partial<Record<ConsoleId, Verdict>> {
  return Object.fromEntries(revision.results.reports.map((r) => [r.console, r.verdict]));
}

/**
 * Derived results (layout, build steps, step pictures, schematic, bench plan, check reports) are computed once per
 * revision and stored. When the code that derives them changes (RevisionResults.derivation ≠ the running version),
 * existing missions would keep showing what old code made; this re-derives them in the background after start.
 *
 * - Only derived results change: circuit, suite, author, note and chat history are never touched (pipeline.evaluate
 *   writes results only). Old artifacts stay served until the new results are saved in one write.
 * - A revision someone is building (build.step or wire-colour events) keeps its stored placement, so the board on the
 *   desk and the chosen wire colours stay valid; its steps and pictures are re-derived from that same placement, and the
 *   progress is mapped onto the new step numbers by what was already placed (build.progress, with a timeline note).
 * - Check verdicts that change are kept (more accurate) and noted on the timeline; a RETRO vote whose other consoles are
 *   no longer all GO goes back to pending.
 * Current and released revisions only; superseded ones keep their results.
 */
export function createDerivedRefresher(deps: {
  store: MissionStore;
  pipeline: Pipeline;
  debug: DebugLog;
  log: Logger;
  version: () => Promise<string | undefined>;
  missionIds: () => Promise<string[]>;
}): DerivedRefresher {
  const { store, pipeline, debug } = deps;
  let stopped = false;
  let active: Promise<unknown> | undefined;

  async function refreshOne(missionId: string, revision: Revision, version: string): Promise<RefreshSummary["refreshed"][number]> {
    const events = await store.listEvents(missionId);
    const building = events.some((e) => e.revision === revision.n && (e.kind === BUILD_STEP_EVENT || e.kind === WIRE_COLOR_EVENT || e.kind === BUILD_PROGRESS_EVENT));
    const keptLayout = building && revision.results.layout !== undefined;
    const before = verdictsOf(revision);
    await pipeline.evaluate(missionId, revision.n, { quiet: true, ...(keptLayout ? { layout: revision.results.layout } : {}) });
    let after = (await store.getRevision(missionId, revision.n))!;

    // RETRO voted on the old results; with the other consoles no longer all GO it waits again (as after any evaluation).
    const retro = after.results.reports.find((r) => r.console === "RETRO");
    if (retro && retro.verdict !== "PENDING" && !deterministicGo(after.results.reports)) {
      const pending = statusReport("RETRO", "PENDING", "The independent review runs once every other console is GO.", after.hash);
      after = await store.saveResults(missionId, revision.n, { reports: after.results.reports.map((r) => (r.console === "RETRO" ? pending : r)) });
    }

    const now = verdictsOf(after);
    const changes = [...DETERMINISTIC_CONSOLES, "RETRO" as const].filter((id) => before[id] !== now[id] && (before[id] !== undefined || now[id] !== undefined));
    if (changes.length) {
      await store.appendEvent({
        missionId,
        channel: "system",
        actor: SYSTEM_ACTOR,
        kind: "revision.rechecked",
        text: `Re-checked revision ${revision.n} with the updated pipeline: ${changes.map((id) => `${CONSOLE_LABELS[id]} ${before[id] ?? "—"} → ${now[id] ?? "—"}`).join(", ")}.`,
        revision: revision.n,
        data: { before, after: now, derivation: version },
      });
    }

    let progress: { from: number; to: number } | undefined;
    const done = doneSteps(events, revision.n);
    if (done.length && revision.results.steps && after.results.steps && !sameStepStructure(revision.results.steps, after.results.steps)) {
      const mapped = remapProgress(revision.results.steps, after.results.steps, done);
      progress = { from: Math.max(...done), to: mapped.length ? Math.max(...mapped) : 0 };
      await store.appendEvent({
        missionId,
        channel: "system",
        actor: SYSTEM_ACTOR,
        kind: BUILD_PROGRESS_EVENT,
        text:
          progress.to > 0
            ? `The build steps were updated (same placement, clearer steps). Your progress carries over: continue at step ${progress.to + 1} of ${after.results.steps.steps.length}.`
            : `The build steps were updated (same placement, clearer steps). Start again at step 1 of ${after.results.steps.steps.length}; what's already on your board stays where it is.`,
        revision: revision.n,
        data: { done: mapped, before: { steps: revision.results.steps.steps.length, reached: progress.from } },
      });
    }
    return { missionId, revision: revision.n, keptLayout, verdictsChanged: changes.length > 0, ...(progress ? { progress } : {}) };
  }

  async function run(): Promise<RefreshSummary> {
    const started = Date.now();
    const summary: RefreshSummary = { refreshed: [], failed: [], skipped: 0, ms: 0 };
    // Current revisions first (what every mission shows), then released ones that are no longer current.
    const targets: { missionId: string; n: number }[] = [];
    const released: { missionId: string; n: number }[] = [];
    for (const missionId of await deps.missionIds()) {
      const mission = await store.getMission(missionId);
      if (mission?.currentRevision !== undefined) targets.push({ missionId, n: mission.currentRevision });
      if (mission?.releasedRevision !== undefined && mission.releasedRevision !== mission.currentRevision) released.push({ missionId, n: mission.releasedRevision });
    }
    // No designs, nothing to compare: the version probe (about a second of work) isn't needed.
    if (!targets.length && !released.length) return { ...summary, ms: Date.now() - started };
    const version = await deps.version();
    if (stopped) return { ...summary, ms: Date.now() - started };
    if (!version) {
      debug.event(null, "pipeline", "derived results not refreshed: the derivation version couldn't be computed", {}, "warn");
      return { ...summary, ms: Date.now() - started };
    }
    summary.version = version;
    const due: { missionId: string; revision: Revision }[] = [];
    for (const { missionId, n } of [...targets, ...released]) {
      const revision = await store.getRevision(missionId, n);
      if (!revision) continue;
      if (revision.results.derivation === version) summary.skipped++;
      else due.push({ missionId, revision });
    }
    if (due.length) debug.event(null, "pipeline", `refreshing derived results of ${due.length} revision${due.length === 1 ? "" : "s"} made by older code`, { version, revisions: due.map((d) => ({ missionId: d.missionId, revision: d.revision.n, from: d.revision.results.derivation ?? null })) });

    for (const { missionId, revision } of due) {
      if (stopped) break;
      const one = Date.now();
      const work = refreshOne(missionId, revision, version);
      active = work.catch(() => undefined);
      try {
        const done = await work;
        summary.refreshed.push(done);
        const note = `re-derived revision ${revision.n} with the updated pipeline${done.keptLayout ? " (placement kept: a build is in progress)" : ""}`;
        const data = { missionId, revision: revision.n, from: revision.results.derivation ?? null, to: version, ms: Date.now() - one, keptLayout: done.keptLayout, verdictsChanged: done.verdictsChanged, ...(done.progress ? { progress: done.progress } : {}) };
        debug.event(null, "pipeline", `${note} — mission ${missionId}`, data);
        debug.event(missionId, "pipeline", note, data);
      } catch (error) {
        summary.failed.push({ missionId, revision: revision.n, error: errorMessage(error) });
        debug.event(null, "pipeline", `couldn't re-derive revision ${revision.n} of mission ${missionId}: ${errorMessage(error)}`.slice(0, 300), { missionId, revision: revision.n, error: errorMessage(error) }, "warn");
        deps.log.warn({ missionId, revision: revision.n, err: errorMessage(error) }, "re-deriving a revision failed");
      } finally {
        active = undefined;
      }
    }
    summary.ms = Date.now() - started;
    if (due.length) {
      debug.event(null, "pipeline", `derived results refreshed: ${summary.refreshed.length} of ${due.length} revisions in ${(summary.ms / 1000).toFixed(1)} s${summary.failed.length ? ` (${summary.failed.length} failed)` : ""}${stopped ? " — stopped early" : ""}`, { version, refreshed: summary.refreshed.length, failed: summary.failed.length, skipped: summary.skipped, ms: summary.ms }, summary.failed.length ? "warn" : "info");
    }
    return summary;
  }

  return {
    run,
    async stop() {
      stopped = true;
      if (active) await Promise.race([active, sleep(STOP_WAIT_MS, undefined, { ref: false })]);
    },
  };
}
