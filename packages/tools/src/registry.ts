import {
  CircuitSchema,
  isPracticeRun,
  CONSOLE_LABELS,
  MODULE_KEYS,
  MODULES,
  parseCircuit,
  type ConsoleReport,
  type Finding,
  type InventoryItem,
  type Mission,
  type MissionStore,
  type Revision,
  type Scenario,
  type TestSuite,
  type ToolDef,
  type ToolRegistry,
} from "@vibread/core";
import { z } from "zod";
import {
  BENCH_ACTIONS,
  BENCH_ACTION_TEXT,
  ToolInputError,
  allGo,
  artifactUrl,
  circuitInterface,
  crashFinding,
  defineTool,
  errorMessage,
  isClaudeNotConnected,
  report,
  requireRevision,
  statusReport,
  verdicts,
  type CircuitInterface,
  traceTools,
  type ToolTraceEvent,
} from "./common.js";
import { TestsNotWrittenError, createDesignOps, type DesignOps, type ReviewOutcome, type TestReview } from "./design.js";
import type { Pipeline } from "./pipeline.js";

/** Model-backed collaborators the registry calls; the agents slice supplies them (tests use mock models). */
export interface RegistryHooks {
  /**
   * Independent test author: sees the brief and the design interface only (never the sketch). `gaps` reports coverage
   * holes. `keep`: scenarios carried over from the previous revision — the author writes new ones for `clauses` only and
   * the returned suite contains both.
   */
  writeTests?(input: {
    missionId: string;
    brief: string;
    design: CircuitInterface;
    coverageGaps: (suite: TestSuite) => string[];
    keep?: Scenario[];
    clauses?: string[];
    signal?: AbortSignal;
  }): Promise<TestSuite>;
  /**
   * The test author reviewing its own failing scenarios against the intent and the simulator's failure timelines (never
   * the sketch). `dispute`: the design agent's reason for thinking a test is wrong.
   */
  reviewTests?(input: {
    missionId: string;
    brief: string;
    design: CircuitInterface;
    failures: { scenario: Scenario; detail: string }[];
    dispute?: string;
    signal?: AbortSignal;
  }): Promise<TestReview[]>;
  /** RETRO reviewer: sees everything, can only vote. */
  review?(input: { mission: Mission; revision: Revision; signal?: AbortSignal }): Promise<ConsoleReport>;
  onEvaluated?(missionId: string, revision: Revision): Promise<void>;
}

const revisionArg = z.number().int().positive().optional().describe("Revision number; the latest revision when omitted.");

/** Longest finding detail the agent reads per finding (failed scenario steps, compiler text, measured values). */
const DETAIL_LIMIT = 600;

interface BriefFinding {
  console: string;
  ruleId: string;
  severity: string;
  title: string;
  detail?: string;
  fix?: string;
  refs?: Finding["refs"];
}

function brief(findings: Finding[]): BriefFinding[] {
  return findings
    .filter((f) => f.severity !== "info")
    .map((f) => ({
      console: f.console,
      ruleId: f.ruleId,
      severity: f.severity,
      title: f.title,
      ...(f.detail ? { detail: f.detail.length > DETAIL_LIMIT ? `${f.detail.slice(0, DETAIL_LIMIT)}…` : f.detail } : {}),
      ...(f.fix ? { fix: f.fix } : {}),
      ...(f.refs ? { refs: f.refs } : {}),
    }));
}

function verdictLine(reports: ConsoleReport[]): string {
  return reports.map((r) => `${CONSOLE_LABELS[r.console]} ${r.verdict}`).join(" · ");
}

/**
 * The placement summary of a revision (which rows/side each part got, and whether requested groups sit together):
 * results.placement, else the FAO report's evidence.placement.
 */
function placementOf(revision: Revision): { text: string; unmet: string[] } | undefined {
  const fao = revision.results.reports.find((r) => r.console === "FAO");
  const placement: unknown = ("placement" in revision.results ? revision.results.placement : undefined) ?? fao?.evidence?.placement;
  if (!placement || typeof placement !== "object" || !("text" in placement) || typeof placement.text !== "string") return undefined;
  const groups: unknown[] = "groups" in placement && Array.isArray(placement.groups) ? placement.groups : [];
  const unmet = groups.flatMap((g) => (g && typeof g === "object" && "met" in g && g.met === false && "detail" in g && typeof g.detail === "string" ? [g.detail] : []));
  return { text: placement.text, unmet };
}

/** What propose_design and dispute_test return to the design agent for a checked revision. */
function designResult(revision: Revision, review?: ReviewOutcome) {
  const reports = revision.results.reports;
  const findings = brief(reports.flatMap((r) => r.findings));
  const notes: string[] = [];
  if (review?.corrected.length) notes.push(`The test author corrected ${review.corrected.join(", ")} (they contradicted the intent) and re-ran them as revision ${revision.n}.`);
  if (review?.setAside.length) notes.push(`ViBread set aside ${review.setAside.join(", ")} (the test review didn't confirm ${review.setAside.length === 1 ? "it matches" : "they match"} the intent): ${review.setAside.length === 1 ? "it only warns" : "they only warn"} now, so carry on.`);
  // A test the review just confirmed is the design's to fix: pointing at dispute_test again would send the agent round in a loop.
  const failing = findings.flatMap((f) => (f.ruleId === "SIM-FAIL" && f.refs?.scenarios?.[0] ? [f.refs.scenarios[0]] : []));
  const confirmed = failing.filter((id) => review?.reviews.some((r) => r.id === id && r.verdict === "design-wrong"));
  if (confirmed.length) {
    notes.push(`The test review confirmed ${confirmed.join(", ")} ${confirmed.length === 1 ? "matches" : "match"} the intent (see testReview): change the sketch or circuit so it does what the clause says — if that means changing a feature the person asked for, ask them with ask_user first.`);
  }
  if (failing.some((id) => !confirmed.includes(id))) {
    notes.push("If a failing test looks wrong rather than the design, call dispute_test — never remove or change user-visible behavior just to pass a test.");
  }
  const placement = placementOf(revision);
  if (placement?.unmet.length) notes.push(`The requested placement wasn't met (${placement.unmet.join("; ")}): follow the PLACEMENT-UNMET fix and propose again, and never describe the layout as if it were met.`);
  return {
    summary: `Revision ${revision.n}: ${verdictLine(reports)}${notes.length ? ` — ${notes.join(" ")}` : ""}`,
    accepted: true,
    revision: revision.n,
    hash: revision.hash,
    verdicts: verdicts(reports),
    allGo: allGo(reports),
    findings,
    consoles: reports.map((r) => ({ console: r.console, verdict: r.verdict, summary: r.summary })),
    ...(review?.reviews.length ? { testReview: review.reviews.map((r) => ({ scenario: r.id, verdict: r.verdict, reason: r.reason, ...(review.corrected.includes(r.id) ? { corrected: true } : {}), ...(review.setAside.includes(r.id) ? { setAside: true } : {}) })) } : {}),
    ...(placement ? { placement: placement.text } : {}),
  };
}

async function requireMission(store: MissionStore, missionId: string): Promise<Mission> {
  const mission = await store.getMission(missionId);
  if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
  return mission;
}

async function appHex(store: MissionStore, revision: Revision): Promise<string> {
  const key = revision.results.artifacts["app.hex"];
  const stored = key ? await store.getArtifact(key) : null;
  if (stored) return new TextDecoder().decode(stored.data);
  const compiled = await (await import("@vibread/firmware")).compileSketch({ source: revision.circuit.sketch.source, board: revision.circuit.board.profile });
  if (!compiled.ok || !compiled.hex) throw new ToolInputError(`Revision ${revision.n} does not compile: ${compiled.diagnostics.map((d) => d.message).join("; ")}`);
  return compiled.hex;
}

/**
 * The ViBread tool surface (PLAN §5.2). Defined once; adapted to the design agent's pi tools (apps/server agents/pi-tools.ts) and to MCP by Channels from
 * `list()`. Engines are imported inside handlers so one broken engine only breaks the tools that need it.
 */
export function createToolRegistry(deps: {
  store: MissionStore;
  pipeline: Pipeline;
  hooks?: RegistryHooks;
  design?: DesignOps;
  /** Called after every tool call (any caller) with its timing and outcome. */
  trace?: (event: ToolTraceEvent) => void;
}): ToolRegistry {
  const { store, pipeline, hooks = {} } = deps;
  const ops = deps.design ?? createDesignOps({ store, pipeline, hooks });

  const defs: ToolDef[] = [
    defineTool({
      name: "list_modules",
      title: "List parts ViBread knows",
      description: "The module library: every supported part with its pins, parameters, and plain-language description.",
      actionClass: "read-only",
      input: z.object({}),
      handler: async () => ({
        summary: `${MODULE_KEYS.length} kinds of parts`,
        modules: MODULE_KEYS.map((key) => {
          const m = MODULES[key];
          return {
            key,
            name: m.name,
            category: m.category,
            description: m.description,
            pins: m.pins.map((p) => ({ id: p.id, name: p.name, ...(p.polarity ? { polarity: p.polarity } : {}) })),
            params: z.toJSONSchema(m.params, { io: "input", unrepresentable: "any" }),
            electrical: m.electrical,
          };
        }),
      }),
    }),
    defineTool({
      name: "get_inventory",
      title: "Your parts",
      description:
        "The parts this mission may use (copied from the user's inventory when it started): module keys, counts, params, " +
        "labels and pinouts for modelled/basic parts, plus parts the user owns that ViBread can't design with.",
      actionClass: "read-only",
      input: z.object({}),
      handler: async (ctx) => {
        const { inventory, inventoryNotes } = await requireMission(store, ctx.missionId);
        const summary = inventory.map((i) => `${i.count}× ${i.label ?? i.module}`).join(", ") || "No parts listed";
        return { summary, inventory, ...(inventoryNotes?.length ? { alsoOwns: inventoryNotes } : {}) };
      },
    }),
    defineTool({
      name: "propose_design",
      title: "Save a design revision",
      description:
        "Save a complete circuit (IR vibread.circuit/0.1 incl. sketch) as revision n+1 and run every Go/No-Go console " +
        "(electrical checks, firmware compile + pin modes, independent simulation tests, breadboard layout/LVS, review). " +
        "Returns each console's verdict and the findings to fix.",
      actionClass: "state-changing",
      input: z.object({
        circuit: CircuitSchema,
        note: z.string().max(300).optional().describe("One line: what changed and why."),
      }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
        const parsed = parseCircuit(input.circuit);
        if (!parsed.ok) {
          return {
            summary: `Design rejected: ${parsed.issues.filter((i) => i.severity === "error").length} structural errors`,
            accepted: false,
            issues: parsed.issues,
          };
        }
        const circuit = parsed.circuit;
        const previous = await store.getRevision(ctx.missionId);

        let suite: TestSuite | undefined;
        let testsNote: string | undefined;
        try {
          // Keeps the previous suite's scenarios for unchanged clauses; asks the author only for changed ones.
          suite = await ops.suiteFor(mission, circuit, ctx.signal, previous);
        } catch (error) {
          testsNote = `The independent test writer's answer couldn't be used: ${errorMessage(error)}`;
        }

        const revision = await store.createRevision(ctx.missionId, {
          circuit,
          ...(suite ? { suite } : {}),
          author: ctx.actor,
          ...(input.note ? { note: input.note } : {}),
          ...(previous ? { parent: previous.n } : {}),
        });
        await store.updateMission(ctx.missionId, { currentRevision: revision.n });
        await store.appendEvent({
          missionId: ctx.missionId,
          channel: ctx.actor.channel,
          actor: ctx.actor,
          kind: "revision.created",
          text: `Revision ${revision.n}: ${input.note ?? circuit.title}`,
          revision: revision.n,
          data: { hash: revision.hash, parent: previous?.n },
        });

        let evaluated = await ops.evaluate(mission, revision.n, ctx.signal);
        if (testsNote) {
          // No suite: FIDO says why instead of waiting silently for tests that won't come.
          const fido = report(
            "FIDO",
            [{ console: "FIDO", ruleId: "TESTS-NOT-WRITTEN", severity: "error", title: "The simulation tests couldn't be written, so nothing was simulated.", detail: testsNote, fix: "Propose the same design again to retry the test writer." }],
            "NO-GO: the independent test writer's answer couldn't be used.",
            revision.hash,
          );
          evaluated = await store.saveResults(ctx.missionId, revision.n, { reports: evaluated.results.reports.map((r) => (r.console === "FIDO" ? fido : r)) });
        }
        // Failed simulation tests are reviewed against the intent before they count against the design (issue #16).
        const reviewed = await ops.reviewFailedTests(mission, evaluated, ctx.signal ? { signal: ctx.signal } : {});
        return {
          ...designResult(reviewed.revision, reviewed),
          ...(parsed.issues.length ? { issues: parsed.issues } : {}),
          ...(testsNote ? { testsNote } : {}),
        };
      },
    }),
    defineTool({
      name: "dispute_test",
      title: "Question a simulation test",
      description:
        "When a failing simulation test (FIDO SIM-FAIL) looks wrong rather than the design — it checks something the intent " +
        "doesn't say, or its timing contradicts the intent — ask the independent test author to review it instead of changing " +
        "the design to pass it. Wrong tests are corrected and re-run as a new revision (same circuit), or set aside (they only " +
        "warn) when the correction doesn't work or the reviewer can't confirm them; tests the reviewer confirms stay, with its " +
        "reason. Never remove or change user-visible behavior just to satisfy a test.",
      actionClass: "state-changing",
      input: z.object({
        revision: revisionArg,
        scenarios: z.array(z.string().regex(/^T\d+$/)).min(1).describe('Failing scenario ids you think are wrong, e.g. ["T1", "T5"].'),
        reason: z.string().min(1).max(1000).describe("Why the test contradicts the intent (cite the clause and the timeline)."),
      }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        // The review records its result as a new revision built from this one: from an older revision that would bring
        // back its circuit and tests over the newer design.
        const latest = await requireRevision(store, ctx.missionId);
        if (latest.n !== revision.n) throw new ToolInputError(`Revision ${revision.n} isn't the latest design (revision ${latest.n} is): dispute the failing tests of revision ${latest.n}, or leave out "revision".`);
        const failing = (revision.results.reports.find((r) => r.console === "FIDO")?.findings ?? []).flatMap((f) => (f.ruleId === "SIM-FAIL" ? (f.refs?.scenarios ?? []) : []));
        const disputed = input.scenarios.filter((id) => failing.includes(id));
        if (!disputed.length) throw new ToolInputError(`None of ${input.scenarios.join(", ")} is a failing simulation test on revision ${revision.n} (failing: ${failing.join(", ") || "none"}).`);
        const reviewed = await ops.reviewFailedTests(mission, revision, { only: disputed, dispute: input.reason, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (!reviewed.reviews.length) {
          throw new ToolInputError(
            "The test review couldn't judge these tests (no independent test author is connected, they weren't written by it, or its answer couldn't be used), so they still count. " +
              "Fix the other findings; if you're sure a test contradicts the intent, name it and say why in your reply — never change user-visible behavior just to pass it.",
          );
        }
        return designResult(reviewed.revision, reviewed);
      },
    }),
    defineTool({
      name: "validate_ir",
      title: "Check a design file",
      description: "Validate a candidate circuit IR (schema + structure) without saving it.",
      actionClass: "read-only",
      input: z.object({ circuit: z.unknown().describe("A vibread.circuit/0.1 object.") }),
      handler: async (_ctx, input) => {
        const parsed = parseCircuit(input.circuit);
        const errors = parsed.issues.filter((i) => i.severity === "error").length;
        return { summary: parsed.ok ? `Valid (${parsed.issues.length} warnings)` : `${errors} errors`, ok: parsed.ok, issues: parsed.issues };
      },
    }),
    defineTool({
      name: "render_schematic",
      title: "Draw the schematic",
      description: "The schematic drawing (SVG) of a revision; returns its artifact URL.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        let hash = revision.results.artifacts["schematic.svg"];
        if (!hash) {
          const svg = await (await import("@vibread/assembly")).renderSchematicSvg(revision.circuit);
          hash = await store.putArtifact(svg, "image/svg+xml");
          await store.saveResults(ctx.missionId, revision.n, { artifacts: { ...revision.results.artifacts, "schematic.svg": hash } });
        }
        return { summary: `Schematic for revision ${revision.n}`, artifact: "schematic.svg", hash, url: artifactUrl(ctx.missionId, revision.n, "schematic.svg") };
      },
    }),
    defineTool({
      name: "run_erc",
      title: "Electrical checks",
      description: "Run the electrical rule check (EECOM): pin currents, LED resistors, pull-ups, reserved pins, shorts.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const r = await (await import("@vibread/checks")).runElectricalChecks(revision.circuit, revision.hash);
        return { summary: `EECOM ${r.verdict}: ${r.summary}`, verdict: r.verdict, findings: r.findings, evidence: r.evidence };
      },
    }),
    defineTool({
      name: "electrical_limits",
      title: "Currents and limits",
      description: "Worst-case currents per pin and in total versus the board limits; optionally cross-checked with SPICE.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg, spice: z.boolean().default(false).describe("Also run the ngspice cross-check.") }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const checks = await import("@vibread/checks");
        const r = await checks.runElectricalChecks(revision.circuit, revision.hash);
        const limits = r.findings.filter((f) => /^(CUR|PWR|LED)-/.test(f.ruleId));
        const spice = input.spice ? await checks.spiceCrossCheck(revision.circuit) : undefined;
        return {
          summary: `${limits.filter((f) => f.severity === "error").length} limit violations${spice ? `; SPICE ${spice.ok ? "agrees" : "disagrees"}` : ""}`,
          evidence: r.evidence,
          findings: limits,
          ...(spice ? { spice } : {}),
        };
      },
    }),
    defineTool({
      name: "explain_finding",
      title: "Explain a finding",
      description: "All details (numbers, fix, highlighted parts/pins/holes) for findings with a rule id in a revision.",
      actionClass: "read-only",
      input: z.object({ ruleId: z.string().min(1), revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const findings = revision.results.reports.flatMap((r) => r.findings).filter((f) => f.ruleId === input.ruleId);
        return {
          summary: findings.length ? `${findings.length}× ${input.ruleId}: ${findings[0]!.title}` : `No ${input.ruleId} finding in revision ${revision.n}`,
          findings,
        };
      },
    }),
    defineTool({
      name: "compile",
      title: "Compile the sketch",
      description: "Compile the revision's sketch (or a candidate source for the same board) with arduino-cli; diagnostics and sizes.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg, source: z.string().min(1).optional().describe("Candidate sketch; the revision's sketch when omitted.") }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const r = await (await import("@vibread/firmware")).compileSketch({
          source: input.source ?? revision.circuit.sketch.source,
          board: revision.circuit.board.profile,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return {
          summary: r.ok ? `Compiled: ${r.sizes ? `${r.sizes.flashBytes}/${r.sizes.flashMax} bytes flash` : "ok"}` : `Compile failed (${r.diagnostics.filter((d) => d.severity === "error").length} errors)`,
          ok: r.ok,
          diagnostics: r.diagnostics,
          sizes: r.sizes,
          durationMs: r.durationMs,
          ...(r.ok ? {} : { log: r.log.slice(0, 4000) }),
        };
      },
    }),
    defineTool({
      name: "pin_mode_check",
      title: "Code ↔ circuit check",
      description: "Simulate the compiled sketch and compare the pin modes it sets against the circuit's pin roles (GUIDO).",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const compile = await (await import("@vibread/firmware")).compileSketch({ source: revision.circuit.sketch.source, board: revision.circuit.board.profile });
        const pinModes = compile.ok && compile.hex ? await (await import("@vibread/sim")).observePinModes({ circuit: revision.circuit, hex: compile.hex }) : [];
        const r = (await import("@vibread/checks")).runFirmwareChecks({ circuit: revision.circuit, compile, pinModes, revisionHash: revision.hash });
        return { summary: `GUIDO ${r.verdict}: ${r.summary}`, verdict: r.verdict, pinModes, findings: r.findings };
      },
    }),
    defineTool({
      name: "run_scenarios",
      title: "Run the simulation tests",
      description: "Run the independent test suite (or selected scenarios) against the compiled sketch in the ATmega328P simulator.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg, only: z.array(z.string().regex(/^T\d+$/)).optional().describe("Scenario ids to run; all when omitted.") }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        // No suite yet (written while Claude wasn't connected): write it now (cached; recorded by the next revision).
        let suite = revision.suite;
        if (!suite) {
          const mission = await requireMission(store, ctx.missionId);
          suite = await ops.suiteFor(mission, revision.circuit, ctx.signal).catch((error: unknown) => {
            if (error instanceof TestsNotWrittenError) {
              throw new ToolInputError("The simulation tests haven't been written yet because Claude isn't connected — connect your Claude account in Settings (or set ANTHROPIC_API_KEY), then try again.");
            }
            throw error;
          });
        }
        const only = input.only;
        const scenarios = only?.length ? suite.scenarios.filter((s) => only.includes(s.id)) : suite.scenarios;
        if (!scenarios.length) throw new ToolInputError(`No scenarios match ${only?.join(", ")}.`);
        const hex = await appHex(store, revision);
        const r = await (await import("@vibread/sim")).runSuite({
          circuit: revision.circuit,
          hex,
          suite: { ...suite, scenarios },
          revisionHash: revision.hash,
        });
        const passed = r.scenarios.filter((s) => s.ok).length;
        return {
          summary: `${passed}/${r.scenarios.length} tests pass; coverage ${r.coverage.ok ? "complete" : "has gaps"}`,
          ...(revision.suite
            ? {}
            : { testsWrittenNow: true, note: `These tests were written just now and aren't part of revision ${revision.n} yet; GO for build (or propose_design with the same circuit) records them.` }),
          scenarios: r.scenarios.map((s) => ({ id: s.id, title: s.title, ok: s.ok, failures: s.steps.filter((st) => !st.ok).map((st) => st.message) })),
          coverage: r.coverage,
          verdict: r.report.verdict,
        };
      },
    }),
    defineTool({
      name: "coverage_report",
      title: "Test coverage",
      description: "Which outputs, inputs, intent clauses, and edge-case categories the independent tests cover.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        if (!revision.suite) throw new ToolInputError(`Revision ${revision.n} has no independent tests yet.`);
        const coverage = (await import("@vibread/sim")).coverageOf(revision.circuit, revision.suite);
        return { summary: coverage.ok ? "Coverage complete" : `Gaps: ${coverage.missing.join("; ")}`, coverage };
      },
    }),
    defineTool({
      name: "layout_board",
      title: "Breadboard layout",
      description: "The deterministic breadboard placement (holes per part pin) and jumpers for a revision.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const lib = await import("@vibread/assembly");
        const layout = revision.results.layout ?? lib.layoutBoard(revision.circuit);
        return {
          summary: `${layout.placements.length} parts, ${layout.jumpers.length} jumpers on ${layout.breadboard}`,
          layoutHash: revision.results.layoutHash ?? lib.layoutHash(layout),
          layout,
          url: artifactUrl(ctx.missionId, revision.n, "breadboard.svg"),
        };
      },
    }),
    defineTool({
      name: "lvs_check",
      title: "Layout vs. schematic",
      description: "Derive nets from the breadboard layout and compare with the circuit's nets (split/merged nets, shorts, floating pins).",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const lib = await import("@vibread/assembly");
        const layout = revision.results.layout ?? lib.layoutBoard(revision.circuit);
        const r = lib.lvs(revision.circuit, layout);
        return { summary: r.ok ? "Layout matches the schematic" : `${r.issues.length} layout issues`, ok: r.ok, issues: r.issues, netMap: r.netMap };
      },
    }),
    defineTool({
      name: "build_steps",
      title: "Build steps",
      description: "The LEGO-style breadboard steps for a revision (plug state, holes, parts callouts, checkpoints).",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const lib = await import("@vibread/assembly");
        const steps = revision.results.steps ?? lib.buildSteps(revision.circuit, revision.results.layout ?? lib.layoutBoard(revision.circuit));
        return {
          summary: `${steps.steps.length} steps`,
          steps: steps.steps.map((s) => ({
            n: s.n,
            kind: s.kind,
            title: s.title,
            text: s.text,
            plug: s.plug,
            ...(s.checkpoint ? { checkpoint: s.checkpoint.text } : {}),
            ...(revision.results.artifacts[`step-${s.n}.png`] ? { imageUrl: artifactUrl(ctx.missionId, revision.n, `step-${s.n}.png`) } : {}),
          })),
        };
      },
    }),
    defineTool({
      name: "diagnose",
      title: "Diagnose the breadboard",
      description: "The diagnosis of the latest (or a given) bench run: attribution (design/code/wiring/component) and ranked causes with holes to check.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg, runId: z.string().optional() }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const runs = revision.results.bench ?? [];
        // Prefer the latest real-board run; a practice (virtual) run is still reported, labelled so it's never taken as the board's status.
        const run = input.runId ? runs.find((r) => r.runId === input.runId) : runs.findLast((candidate) => !isPracticeRun(candidate)) ?? runs.at(-1);
        if (!run) return { summary: `No bench runs for revision ${revision.n} yet`, runs: 0 };
        return { summary: run.diagnosis.summary, runId: run.runId, practice: isPracticeRun(run), verdict: run.verdict, attribution: run.diagnosis.attribution, candidates: run.diagnosis.candidates };
      },
    }),
    defineTool({
      name: "explain_telemetry",
      title: "Self-test results",
      description: "Per-test, per-part observed vs expected readings from the latest (or a given) bench run, plus calibration.",
      actionClass: "read-only",
      input: z.object({ revision: revisionArg, runId: z.string().optional() }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const runs = revision.results.bench ?? [];
        const run = input.runId ? runs.find((r) => r.runId === input.runId) : runs.findLast((candidate) => !isPracticeRun(candidate)) ?? runs.at(-1);
        if (!run) return { summary: `No bench runs for revision ${revision.n} yet`, runs: 0 };
        const failed = run.results.filter((t) => t.status === "fail").length;
        return { summary: `${isPracticeRun(run) ? "practice (virtual board) " : ""}${run.kind} run ${run.verdict}: ${failed} failing tests`, runId: run.runId, practice: isPracticeRun(run), kind: run.kind, verdict: run.verdict, results: run.results, calibration: run.calibration };
      },
    }),
    defineTool({
      name: "request_bench_action",
      title: "Ask for a bench action",
      description:
        "Request a physical action (flash firmware, rail checkpoint, self-test) on the RELEASED revision (the build target). It " +
        "never runs from here: it waits for the person to click Start in the bench browser that holds the USB port.",
      actionClass: "physical",
      input: z.object({
        action: z.enum(BENCH_ACTIONS),
        revision: revisionArg.describe("Must be the released revision (the build target the bench runs); defaults to it."),
        note: z.string().max(200).optional(),
      }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
        // The bench runs the released revision (the build target); a request is bound to its hash (gate.ts).
        const n = mission.releasedRevision;
        if (n === undefined) throw new ToolInputError("Nothing is released for the bench yet — press GO for build first.");
        if (input.revision !== undefined && input.revision !== n) {
          throw new ToolInputError(`The bench runs the released revision (${n}), not revision ${input.revision}. Release revision ${input.revision} first (GO for build).`);
        }
        return {
          summary: `${BENCH_ACTION_TEXT[input.action]} — waiting for a click at the bench`,
          action: input.action,
          revision: n,
          benchUrl: `/m/${encodeURIComponent(ctx.missionId)}/bench`,
          executes: "only when the person clicks Start in the bench browser",
        };
      },
    }),
    defineTool({
      name: "add_part",
      title: "Add a part to your list",
      description:
        "Add a part to this mission's parts list when the design needs something the user didn't list. Say plainly that they " +
        "need to have it; the output says whether it's in their inventory.",
      actionClass: "bom-change",
      input: z.object({
        module: z.enum(MODULE_KEYS),
        count: z.number().int().positive().max(20),
        params: z.record(z.string(), z.unknown()).optional(),
        note: z.string().max(200).optional().describe("Why the design needs it."),
      }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
        const owned = mission.inventory.some(
          (item) => item.module === input.module && Object.entries(input.params ?? {}).every(([key, value]) => item.params?.[key] === undefined || item.params[key] === value),
        );
        const params = input.params ? MODULES[input.module].params.safeParse(input.params) : undefined;
        if (params && !params.success) throw new ToolInputError(`Invalid params for ${input.module}: ${params.error.message}`);
        const item: InventoryItem = {
          module: input.module,
          count: input.count,
          ...(params?.success ? { params: params.data } : {}),
          ...(input.note ? { note: input.note } : {}),
        };
        await store.updateMission(ctx.missionId, { inventory: [...mission.inventory, item] });
        await store.appendEvent({
          missionId: ctx.missionId,
          channel: ctx.actor.channel,
          actor: ctx.actor,
          kind: "inventory.added",
          text: `Added ${item.count}× ${MODULES[item.module].name} to the parts list.`,
          data: item,
        });
        const name = MODULES[item.module].name;
        return {
          summary: `Added ${item.count}× ${name}${owned ? "" : " — not in your inventory; make sure you have one"}`,
          inInventory: owned,
          item,
        };
      },
    }),
  ];

  const tools = deps.trace ? traceTools(defs, deps.trace) : defs;
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => [...tools],
    get: (name) => byName.get(name),
  };
}
