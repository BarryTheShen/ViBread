import { CONSOLE_LABELS, type Actor, type ApprovalBroker, type ConsoleId, type Mission, type MissionDetail, type MissionService, type MissionStore, type Revision, type ToolRegistry, type Verdict } from "@vibread/core";
import { DETERMINISTIC_CONSOLES, TestsNotWrittenError, ToolInputError, invokeTool, reviewRevision, type DesignOps, type RegistryHooks } from "@vibread/tools";
import type { ApprovalLinks } from "./approval-links.js";
import type { RunManager } from "./runs.js";

export interface ReleaseInput {
  missionId: string;
  revision: number;
  /** The human who clicked "GO for build" (web session). */
  actor: Actor;
  /** Release even though RETRO could not run (Claude isn't connected). */
  acknowledgeMissingReview?: boolean;
}

function conflict(code: string, message: string): ToolInputError {
  return Object.assign(new ToolInputError(message, 409), { code });
}

/**
 * Human release (PLAN §1 "human GO", §5.10): the Flight Director releases a revision as the build target from the UI.
 * Runs the same `release_revision` ToolDef through the policy gate; the click itself is the approval, so a required
 * approval is decided approve-once by this human and consumed one-shot. Permission modes gate the agent, not the human.
 *
 * Release rules (recorded in PLAN.md):
 *  - EECOM, GUIDO, FIDO, FAO must all be GO for the released revision. A revision without independent tests gets them
 *    written first when a credential exists (recorded as revision n+1); without one → 409 tests_missing.
 *  - RETRO must be GO. A RETRO NO-GO always blocks (409 retro_no_go).
 *  - Only when RETRO could not run because no Claude credential exists (neither the owner's account nor the server key)
 *    may the human release without it, and only with the explicit `acknowledgeMissingReview: true`; the waiver is written
 *    to the timeline ("Released by <name> without the independent review — Claude isn't connected").
 */
export function createHumanRelease(deps: {
  store: MissionStore;
  broker: ApprovalBroker;
  tools: ToolRegistry;
  design: DesignOps;
  missions: MissionService;
  runs: RunManager;
  links: ApprovalLinks;
  review?: RegistryHooks["review"];
  /** Some credential (owner's Claude account or server key) can run the reviewer for this owner. */
  claudeConnected(ownerId: string): Promise<boolean>;
}): (input: ReleaseInput) => Promise<MissionDetail> {
  const { store, broker, tools, design, missions, runs, links } = deps;

  async function requireMission(missionId: string): Promise<Mission> {
    const mission = await store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    return mission;
  }

  return async function release(input) {
    const { missionId, actor } = input;
    const mission = await requireMission(missionId);
    const requested = await store.getRevision(missionId, input.revision);
    if (!requested) throw new ToolInputError(`Revision ${input.revision} does not exist.`, 404);
    if (mission.releasedRevision === requested.n) return missions.detail(missionId);

    const blockingIn = (revision: Revision, skipFido: boolean): { id: ConsoleId; verdict: Verdict }[] =>
      DETERMINISTIC_CONSOLES.filter((id) => !(skipFido && id === "FIDO"))
        .map((id) => ({ id, verdict: revision.results.reports.find((r) => r.console === id)?.verdict ?? "PENDING" }))
        .filter((c) => c.verdict !== "GO");
    const notGo = (revision: Revision, blocking: { id: ConsoleId; verdict: Verdict }[]) =>
      conflict("not_all_go", `Revision ${revision.n} isn't GO yet: ${blocking.map((c) => `${CONSOLE_LABELS[c.id]} (${c.id}) ${c.verdict}`).join(", ")}.`);

    // A revision saved while no credential was available has no independent tests (FIDO PENDING): write them now,
    // record them as revision n+1 (same circuit; the suite is part of the revision hash) and release that one.
    let found = requested;
    const early = blockingIn(found, !found.suite);
    if (early.length) throw notGo(found, early);
    if (!found.suite) {
      const suite = await design.suiteFor(mission, found.circuit).catch((error: unknown) => {
        if (error instanceof TestsNotWrittenError) {
          throw conflict(
            "tests_missing",
            "The simulation tests haven't been written yet because Claude isn't connected — connect your Claude account in Settings (or set ANTHROPIC_API_KEY), then press GO for build again.",
          );
        }
        throw error;
      });
      found = await design.recordSuite(mission, found, suite);
    }
    const n = found.n;
    const blocking = blockingIn(found, false);
    if (blocking.length) throw notGo(found, blocking);

    // RETRO: run it now if it never ran for this revision, or if it was skipped and Claude is connected now.
    let retro = found.results.reports.find((r) => r.console === "RETRO" && r.revisionHash === found.hash);
    if (!retro || (retro.verdict !== "GO" && retro.verdict !== "NO-GO" && (await deps.claudeConnected(mission.ownerId)))) {
      const reviewed = await reviewRevision({ store, mission, n, ...(deps.review ? { review: deps.review } : {}) });
      retro = reviewed.results.reports.find((r) => r.console === "RETRO");
    }
    if (retro?.verdict === "NO-GO") throw conflict("retro_no_go", `The independent review voted NO-GO: ${retro.summary}`);
    const reviewMissing = retro?.verdict !== "GO";
    if (reviewMissing) {
      // The waiver exists only for "no Claude credential at all"; with a credential, RETRO must actually vote GO.
      if (await deps.claudeConnected(mission.ownerId)) {
        throw conflict("retro_missing", `The independent review hasn't voted GO yet (${retro?.summary ?? "no review"}). Try GO for build again.`);
      }
      if (!input.acknowledgeMissingReview) {
        throw conflict(
          "retro_missing",
          `The independent review couldn't run (${retro?.summary ?? "no review"}). Confirm to release revision ${n} without it.`,
        );
      }
    }

    const args = { revision: n };
    const ctx = { missionId, actor };
    let result = await invokeTool({ registry: tools, broker, store, ctx, name: "release_revision", args });
    if (result.status === "approval-required") {
      const request = result.approval;
      await links.hydrate(missionId);
      const link = links.forBroker(request.id);
      if (link) {
        // The agent is waiting on this exact release: approving its card resumes it, and it executes the release.
        await missions.decide(link.approvalId, "approve-once", actor).catch(() => undefined);
        await runs.active(missionId)?.finished;
      } else {
        await broker.decide(request.id, "approve-once", actor);
      }
      const after = await requireMission(missionId);
      if (after.releasedRevision !== n) result = await invokeTool({ registry: tools, broker, store, ctx, name: "release_revision", args, approvalId: request.id });
      else result = { status: "executed", output: null };
    }
    if (result.status === "denied") throw conflict("release_denied", result.reason);
    if (result.status !== "executed") throw new Error(`Unexpected release outcome: ${result.status}`);

    if (reviewMissing) {
      await store.appendEvent({
        missionId,
        channel: actor.channel,
        actor,
        kind: "release.review-waived",
        text: `Released by ${actor.name ?? actor.id} without the independent review — Claude isn't connected.`,
        revision: n,
        data: { retro: retro?.verdict ?? "missing" },
      });
    }
    return missions.detail(missionId);
  };
}
