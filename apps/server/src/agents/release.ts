import { CONSOLE_LABELS, type Actor, type ConsoleId, type Mission, type MissionDetail, type MissionService, type MissionStore, type Revision, type SafetyOverride, type Verdict } from "@vibread/core";
import { DETERMINISTIC_CONSOLES, TestsNotWrittenError, ToolInputError, reviewRevision, type DesignOps, type RegistryHooks } from "@vibread/tools";

export interface ReleaseInput {
  missionId: string;
  revision: number;
  /** The person who pressed GO for build (web, or a linked iMessage handle). */
  actor: Actor;
  /** Release even though RETRO could not run (Claude isn't connected). */
  acknowledgeMissingReview?: boolean;
  /** Explicitly bypass release safety gates; only a human web actor may use this. */
  override?: SafetyOverride;
}

function conflict(code: string, message: string): ToolInputError {
  return Object.assign(new ToolInputError(message, 409), { code });
}
function invalidOverride(message: string, status = 400): ToolInputError {
  return Object.assign(new ToolInputError(message, status), { code: status === 403 ? "override_not_allowed" : "invalid_override" });
}

function validateOverride(actor: Actor, value: unknown): SafetyOverride | undefined {
  if (value === undefined) return undefined;
  if (actor.kind !== "human" || actor.channel !== "web") throw invalidOverride("Safety overrides are only allowed from a human web action.", 403);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidOverride("override must be an object");
  const reason = "reason" in value ? value.reason : undefined;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 200)) throw invalidOverride("override.reason must be an optional string of at most 200 characters");
  return reason === undefined ? {} : { reason };
}

/** Scenario names of a FIDO finding rule (titles from the simulation results when present). */
function scenarioNames(revision: Revision, ruleId: "SIM-FAIL" | "TEST-SET-ASIDE"): string[] {
  const fido = revision.results.reports.find((report) => report.console === "FIDO");
  const ids = fido?.findings.filter((finding) => finding.ruleId === ruleId).flatMap((finding) => finding.refs?.scenarios ?? []) ?? [];
  const titles = new Map((revision.results.sim?.scenarios ?? []).map((scenario) => [scenario.id, scenario.title || scenario.id]));
  return [...new Set(ids)].map((id) => titles.get(id) ?? id);
}

function fidoDetails(revision: Revision): string {
  const failed = scenarioNames(revision, "SIM-FAIL");
  const setAside = scenarioNames(revision, "TEST-SET-ASIDE");
  const details: string[] = [];
  if (failed.length > 0) details.push(`failed scenarios: ${failed.join(", ")}`);
  // Tests the test review set aside only warn; they're listed so the person sees them, not as a bypassed gate.
  if (setAside.length > 0) details.push(`set-aside tests (warnings only): ${setAside.join(", ")}`);
  return details.join("; ");
}

function bypassedChecks(revision: Revision, retro: Revision["results"]["reports"][number] | undefined): string[] {
  const bypassed: string[] = [];
  if (!revision.suite) bypassed.push("Simulation tests (FIDO) not written");
  for (const id of DETERMINISTIC_CONSOLES) {
    const report = revision.results.reports.find((candidate) => candidate.console === id);
    const verdict = report?.verdict ?? "PENDING";
    if (verdict === "GO" || (id === "FIDO" && !revision.suite)) continue;
    const details = id === "FIDO" ? fidoDetails(revision) : "";
    bypassed.push(`${CONSOLE_LABELS[id]} (${id}) ${verdict}${details ? ` — ${details}` : ""}`);
  }
  if (retro?.verdict === "NO-GO") bypassed.push(`Independent review (RETRO) NO-GO${retro.summary ? ` — ${retro.summary}` : ""}`);
  else if (retro?.verdict !== "GO") bypassed.push("independent review not run");
  return bypassed;
}

function overrideText(actor: Actor, bypassed: string[], reason: string | undefined): string {
  const who = actor.name ?? actor.id;
  return `Released by ${who} with an override — bypassed: ${bypassed.length > 0 ? bypassed.join(", ") : "no safety checks"}${reason ? `. Reason: ${reason}` : ""}`;
}

/**
 * GO for build (PLAN §1 "human GO"): releasing a revision as the build target is only ever a person's action — the web's
 * GO for build button or an iMessage "GO". Agents and MCP/A2A clients can't release; they tell the person to press it.
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
  design: DesignOps;
  missions: MissionService;
  onReleased(missionId: string, n: number): Promise<void>;
  review?: RegistryHooks["review"];
  /** Some credential (owner's Claude account or server key) can run the reviewer for this owner. */
  claudeConnected(ownerId: string): Promise<boolean>;
}): (input: ReleaseInput) => Promise<MissionDetail> {
  const { store, design, missions } = deps;

  async function requireMission(missionId: string): Promise<Mission> {
    const mission = await store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    return mission;
  }

  return async function release(input) {
    const { missionId, actor } = input;
    const override = validateOverride(actor, input.override);
    const mission = await requireMission(missionId);
    const requested = await store.getRevision(missionId, input.revision);
    if (!requested) throw new ToolInputError(`Revision ${input.revision} does not exist.`, 404);
    if (mission.releasedRevision === requested.n) return missions.detail(missionId);

    const blockingIn = (revision: Revision, skipFido: boolean): { id: ConsoleId; verdict: Verdict }[] =>
      DETERMINISTIC_CONSOLES.filter((id) => !(skipFido && id === "FIDO"))
        .map((id) => ({ id, verdict: revision.results.reports.find((r) => r.console === id)?.verdict ?? "PENDING" }))
        .filter((c) => c.verdict !== "GO");
    const notGo = (revision: Revision, blocking: { id: ConsoleId; verdict: Verdict }[]) => {
      const fido = blocking.some((candidate) => candidate.id === "FIDO") ? fidoDetails(revision) : "";
      return conflict("not_all_go", `Revision ${revision.n} isn't GO yet: ${blocking.map((c) => `${CONSOLE_LABELS[c.id]} (${c.id}) ${c.verdict}`).join(", ")}${fido ? ` — ${fido}` : ""}.`);
    };

    // An override releases the requested revision as-is: it never writes tests or runs a missing review.
    let found = requested;
    let retro = found.results.reports.find((r) => r.console === "RETRO" && r.revisionHash === found.hash);
    if (!override) {
      // A revision saved while no credential was available has no independent tests (FIDO PENDING): write them now,
      // record them as revision n+1 (same circuit; the suite is part of the revision hash) and release that one.
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
      const blocking = blockingIn(found, false);
      if (blocking.length) throw notGo(found, blocking);

      // RETRO: run it now if it never ran for this revision, or if it was skipped and Claude is connected now.
      retro = found.results.reports.find((r) => r.console === "RETRO" && r.revisionHash === found.hash);
      if (!retro || (retro.verdict !== "GO" && retro.verdict !== "NO-GO" && (await deps.claudeConnected(mission.ownerId)))) {
        const reviewed = await reviewRevision({ store, mission, n: found.n, ...(deps.review ? { review: deps.review } : {}) });
        retro = reviewed.results.reports.find((r) => r.console === "RETRO");
      }
    }
    if (!override && retro?.verdict === "NO-GO") throw conflict("retro_no_go", `The independent review voted NO-GO: ${retro.summary}`);
    const reviewMissing = retro?.verdict !== "GO";
    if (!override && reviewMissing) {
      // The waiver exists only for "no Claude credential at all"; with a credential, RETRO must actually vote GO.
      if (await deps.claudeConnected(mission.ownerId)) {
        throw conflict("retro_missing", `The independent review hasn't voted GO yet (${retro?.summary ?? "no review"}). Try GO for build again.`);
      }
      if (!input.acknowledgeMissingReview) {
        throw conflict(
          "retro_missing",
          `The independent review couldn't run (${retro?.summary ?? "no review"}). Confirm to release revision ${found.n} without it.`,
        );
      }
    }
    const bypassed = override ? bypassedChecks(found, retro) : [];
    const n = found.n;

    await store.updateMission(missionId, { releasedRevision: n });
    await store.appendEvent({
      missionId,
      channel: actor.channel,
      actor,
      kind: "revision.released",
      text: `Revision ${n} released for building.`,
      revision: n,
      data: { hash: found.hash },
    });
    await deps.onReleased(missionId, n);

    if (override) {
      await store.appendEvent({
        missionId,
        channel: actor.channel,
        actor,
        kind: "release.override",
        text: overrideText(actor, bypassed, override.reason),
        revision: n,
        data: { bypassed, ...(override.reason !== undefined ? { reason: override.reason } : {}) },
      });
    }
    const recordedVote = (retro?.evidence as { recorded?: { label?: string } } | undefined)?.recorded;
    if (!reviewMissing && recordedVote?.label) {
      // A recorded RETRO vote (recorded.ts) reviewed exactly this revision; it counts, and the release says so.
      await store.appendEvent({
        missionId,
        channel: actor.channel,
        actor,
        kind: "release.review-recorded",
        text: `Released by ${actor.name ?? actor.id} with a recorded independent review (${recordedVote.label}).`,
        revision: n,
        data: { recorded: recordedVote },
      });
    }
    if (!override && reviewMissing) {
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
