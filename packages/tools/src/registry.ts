import {
  CircuitSchema,
  CONSOLE_LABELS,
  MODULE_KEYS,
  MODULES,
  hashJson,
  parseCircuit,
  type ConsoleReport,
  type Finding,
  type InventoryItem,
  type Mission,
  type MissionStore,
  type Revision,
  type TestSuite,
  type ToolDef,
  type ToolRegistry,
} from "@vibread/core";
import { z } from "zod";
import {
  ToolInputError,
  allGo,
  artifactUrl,
  circuitInterface,
  crashFinding,
  defineTool,
  deterministicGo,
  errorMessage,
  isClaudeNotConnected,
  requireRevision,
  statusReport,
  verdicts,
  type CircuitInterface,
} from "./common.js";
import type { Pipeline } from "./pipeline.js";

/** Model-backed collaborators the registry calls; the agents slice supplies them (tests use mock models). */
export interface RegistryHooks {
  /** Independent test author: sees the brief and the design interface only (never the sketch). `gaps` reports coverage holes. */
  writeTests?(input: {
    missionId: string;
    brief: string;
    design: CircuitInterface;
    coverageGaps: (suite: TestSuite) => string[];
    signal?: AbortSignal;
  }): Promise<TestSuite>;
  /** RETRO reviewer: sees everything, can only vote. */
  review?(input: { mission: Mission; revision: Revision; signal?: AbortSignal }): Promise<ConsoleReport>;
  onEvaluated?(missionId: string, revision: Revision): Promise<void>;
  onReleased?(missionId: string, n: number): Promise<void>;
}

const revisionArg = z.number().int().positive().optional().describe("Revision number; the latest revision when omitted.");
const BENCH_ACTIONS = ["flash-bench", "rail-checkpoint", "run-selftest", "flash-app"] as const;
const BENCH_ACTION_TEXT: Record<(typeof BENCH_ACTIONS)[number], string> = {
  "flash-bench": "Put ViBread's safe self-test firmware on the board",
  "rail-checkpoint": "Run the power-rail checkpoint",
  "run-selftest": "Run the full self-test of the breadboard",
  "flash-app": "Flash your project's sketch to the board",
};

function brief(findings: Finding[]): { console: string; ruleId: string; severity: string; title: string; fix?: string; refs?: Finding["refs"] }[] {
  return findings
    .filter((f) => f.severity !== "info")
    .map((f) => ({ console: f.console, ruleId: f.ruleId, severity: f.severity, title: f.title, ...(f.fix ? { fix: f.fix } : {}), ...(f.refs ? { refs: f.refs } : {}) }));
}

function verdictLine(reports: ConsoleReport[]): string {
  return reports.map((r) => `${CONSOLE_LABELS[r.console]} ${r.verdict}`).join(" · ");
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

/**
 * The ViBread tool surface (PLAN §5.2). Defined once; adapted to AI SDK tools (ai-sdk.ts) and to MCP by Channels from
 * `list()`. Engines are imported inside handlers so one broken engine only breaks the tools that need it.
 */
export function createToolRegistry(deps: { store: MissionStore; pipeline: Pipeline; hooks?: RegistryHooks }): ToolRegistry {
  const { store, pipeline, hooks = {} } = deps;

  async function evaluateWithReview(mission: Mission, n: number, signal?: AbortSignal): Promise<Revision> {
    await pipeline.evaluate(mission.id, n);
    const revision = await reviewRevision({ store, mission, n, ...(hooks.review ? { review: hooks.review } : {}), ...(signal ? { signal } : {}) });
    await hooks.onEvaluated?.(mission.id, revision);
    return revision;
  }

  const tools: ToolDef[] = [
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
      description: "The parts the user has on hand for this mission (module keys, counts, params).",
      actionClass: "read-only",
      input: z.object({}),
      handler: async (ctx) => {
        const { inventory } = await requireMission(store, ctx.missionId);
        return { summary: inventory.map((i) => `${i.count}× ${i.module}`).join(", ") || "No parts listed", inventory };
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
        const design = circuitInterface(circuit);
        const interfaceKey = (c: CircuitInterface) => hashJson({ parts: c.parts, roles: c.roles, intent: c.intent, board: c.board });

        let suite: TestSuite | undefined;
        let testsNote: string | undefined;
        if (previous?.suite && interfaceKey(circuitInterface(previous.circuit)) === interfaceKey(design)) {
          suite = previous.suite;
        } else if (hooks.writeTests) {
          try {
            const { coverageOf } = await import("@vibread/sim");
            suite = await hooks.writeTests({
              missionId: ctx.missionId,
              brief: mission.brief,
              design,
              coverageGaps: (candidate) => coverageOf(circuit, candidate).missing,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          } catch (error) {
            testsNote = `Independent tests were not written: ${errorMessage(error)}`;
          }
        } else {
          testsNote = "No independent test author is configured.";
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

        const evaluated = await evaluateWithReview(mission, revision.n, ctx.signal);
        const reports = evaluated.results.reports;
        const go = allGo(reports);
        return {
          summary: `Revision ${revision.n}: ${verdictLine(reports)}`,
          accepted: true,
          revision: revision.n,
          hash: revision.hash,
          verdicts: verdicts(reports),
          allGo: go,
          findings: brief(reports.flatMap((r) => r.findings)),
          ...(parsed.issues.length ? { issues: parsed.issues } : {}),
          ...(testsNote ? { testsNote } : {}),
          consoles: reports.map((r) => ({ console: r.console, verdict: r.verdict, summary: r.summary })),
        };
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
        if (!revision.suite) throw new ToolInputError(`Revision ${revision.n} has no independent tests yet.`);
        const only = input.only;
        const scenarios = only?.length ? revision.suite.scenarios.filter((s) => only.includes(s.id)) : revision.suite.scenarios;
        if (!scenarios.length) throw new ToolInputError(`No scenarios match ${only?.join(", ")}.`);
        const hex = await appHex(store, revision);
        const r = await (await import("@vibread/sim")).runSuite({
          circuit: revision.circuit,
          hex,
          suite: { ...revision.suite, scenarios },
          revisionHash: revision.hash,
        });
        const passed = r.scenarios.filter((s) => s.ok).length;
        return {
          summary: `${passed}/${r.scenarios.length} tests pass; coverage ${r.coverage.ok ? "complete" : "has gaps"}`,
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
        const run = input.runId ? runs.find((r) => r.runId === input.runId) : runs.at(-1);
        if (!run) return { summary: `No bench runs for revision ${revision.n} yet`, runs: 0 };
        return { summary: run.diagnosis.summary, runId: run.runId, verdict: run.verdict, attribution: run.diagnosis.attribution, candidates: run.diagnosis.candidates };
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
        const run = input.runId ? runs.find((r) => r.runId === input.runId) : runs.at(-1);
        if (!run) return { summary: `No bench runs for revision ${revision.n} yet`, runs: 0 };
        const failed = run.results.filter((t) => t.status === "fail").length;
        return { summary: `${run.kind} run ${run.verdict}: ${failed} failing tests`, runId: run.runId, kind: run.kind, verdict: run.verdict, results: run.results, calibration: run.calibration };
      },
    }),
    defineTool({
      name: "release_revision",
      title: "Release for building",
      description: "Release a revision as the build target (breadboard steps + firmware). Needs every console GO; asks the human unless Autopilot and all GO.",
      actionClass: "release",
      input: z.object({ revision: z.number().int().positive() }),
      handler: async (ctx, input) => {
        const revision = await requireRevision(store, ctx.missionId, input.revision);
        const reports = revision.results.reports;
        if (!deterministicGo(reports)) {
          throw new ToolInputError(`Revision ${revision.n} is not GO (${verdictLine(reports)}); fix the findings first.`);
        }
        if (reports.find((r) => r.console === "RETRO")?.verdict === "NO-GO") {
          throw new ToolInputError(`The independent review voted NO-GO on revision ${revision.n}.`);
        }
        await store.updateMission(ctx.missionId, { releasedRevision: revision.n });
        await store.appendEvent({
          missionId: ctx.missionId,
          channel: ctx.actor.channel,
          actor: ctx.actor,
          kind: "revision.released",
          text: `Revision ${revision.n} released for building.`,
          revision: revision.n,
          data: { hash: revision.hash },
        });
        await hooks.onReleased?.(ctx.missionId, revision.n);
        return {
          summary: `Revision ${revision.n} is the build target`,
          revision: revision.n,
          steps: revision.results.steps?.steps.length ?? 0,
          buildUrl: `/b/${encodeURIComponent(ctx.missionId)}`,
          benchUrl: `/m/${encodeURIComponent(ctx.missionId)}/bench`,
        };
      },
    }),
    defineTool({
      name: "request_bench_action",
      title: "Ask for a bench action",
      description:
        "Request a physical action (flash firmware, rail checkpoint, self-test). It never runs from here: it waits for the person " +
        "to click Start in the bench browser that holds the USB port.",
      actionClass: "physical",
      input: z.object({ action: z.enum(BENCH_ACTIONS), revision: revisionArg, note: z.string().max(200).optional() }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
        const n = input.revision ?? mission.releasedRevision ?? (await store.getRevision(ctx.missionId))?.n;
        if (n === undefined) throw new ToolInputError("There is no revision to use at the bench yet.");
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
      description: "Add a part to the user's inventory (bill of materials change). Always asks the human first.",
      actionClass: "bom-change",
      input: z.object({
        module: z.enum(MODULE_KEYS),
        count: z.number().int().positive().max(20),
        params: z.record(z.string(), z.unknown()).optional(),
        note: z.string().max(200).optional().describe("Why the design needs it."),
      }),
      handler: async (ctx, input) => {
        const mission = await requireMission(store, ctx.missionId);
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
        return { summary: `Added ${item.count}× ${MODULES[item.module].name}`, item };
      },
    }),
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => [...tools],
    get: (name) => byName.get(name),
  };
}
