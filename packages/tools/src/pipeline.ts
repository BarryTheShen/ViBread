import {
  CONSOLE_LABELS,
  parseCircuit,
  type Circuit,
  type CompileResult,
  type ConsoleId,
  type ConsoleReport,
  type Finding,
  type MissionStore,
  type PinModeObservation,
  type Revision,
  type RevisionResults,
  type StepList,
} from "@vibread/core";
import type * as AssemblyLib from "@vibread/assembly";
import { SYSTEM_ACTOR, crashFinding, report, statusReport, withFindings } from "./common.js";
import { createFaultQueue, type BackgroundLog } from "./faults.js";

/** Runs every deterministic console for one revision and saves RevisionResults + artifacts (local://contracts.md). */
export interface Pipeline {
  evaluate(missionId: string, n: number): Promise<RevisionResults>;
}

/** createPipeline's result: the contract plus a barrier for background work (fault dictionaries). */
export interface BackgroundPipeline extends Pipeline {
  /** Resolves once every queued fault dictionary has been built or has failed. */
  idle(): Promise<void>;
}

type Stage<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number };

const PNG_WIDTH = 1200;
/** Step pictures rendered at once; resvg work runs off the main thread when svgToPng is async. */
const IMAGE_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight; the first rejection rejects the whole batch. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Per-evaluation state shared by the branches: timings, artifact keys, the results patch, extra findings. */
class Run {
  readonly timings: Record<string, number> = {};
  readonly artifacts: Record<string, string> = {};
  readonly patch: Partial<RevisionResults> = {};
  readonly reports = new Map<ConsoleId, ConsoleReport>();
  readonly extra: Record<ConsoleId, Finding[]> = { EECOM: [], GUIDO: [], FIDO: [], FAO: [], RETRO: [] };
  /** Bench firmware HEX, kept for the background fault dictionary. */
  benchHex?: string;

  constructor(
    private readonly store: MissionStore,
    readonly revision: Revision,
  ) {}

  get hash(): string {
    return this.revision.hash;
  }

  async stage<T>(name: string, fn: () => Promise<T> | T): Promise<Stage<T>> {
    const started = performance.now();
    try {
      const value = await fn();
      return { ok: true, value, ms: (this.timings[name] = Math.round(performance.now() - started)) };
    } catch (error) {
      return { ok: false, error, ms: (this.timings[name] = Math.round(performance.now() - started)) };
    }
  }

  async put(key: string, data: Uint8Array | string, contentType: string): Promise<void> {
    this.artifacts[key] = await this.store.putArtifact(data, contentType);
  }
}

/**
 * Four independent branches run concurrently after parsing:
 *   EECOM (+ SPICE cross-check as non-blocking evidence) · firmware (compile → pin modes ∥ suite → GUIDO, FIDO) · assembly (layout/LVS/FAO/steps → drawings ∥ schematic)
 *   · bench (self-test plan → bench firmware).
 * Every stage is timed and failure-isolated: a thrown stage becomes an error finding on its console. After the results
 * are saved, the fault dictionary (`faults.json`) is queued in the background (faults.ts); `faults: false` disables it.
 *
 * Engines are imported inside their stage on purpose (not statically): a module-load failure — e.g. @tscircuit/core's
 * ESM directory-import crash outside tsx, a missing toolchain binding — must fail only that stage, never the server.
 */
export function createPipeline(deps: { store: MissionStore; log?: BackgroundLog; faults?: boolean }): BackgroundPipeline {
  const { store } = deps;
  const faultQueue = createFaultQueue({ store, ...(deps.log ? { log: deps.log } : {}) });

  async function eecomBranch(run: Run, circuit: Circuit, irWarnings: Finding[]): Promise<void> {
    const [eecom, spice] = await Promise.all([
      run.stage("eecom", async () => (await import("@vibread/checks")).runElectricalChecks(circuit, run.hash)),
      run.stage("spice", async () => (await import("@vibread/checks")).spiceCrossCheck(circuit)),
    ]);
    // SPICE is corroborating evidence (PLAN §5.5, item 13): it never blocks. Its errors become warnings; a missing
    // ngspice or a crash is an info finding.
    const spiceFindings: Finding[] = spice.ok
      ? spice.value.findings.map((f) => (f.severity === "error" ? { ...f, severity: "warning" as const } : f))
      : [{ ...crashFinding("EECOM", "SPICE cross-check", spice.error, "info"), fix: "Electrical checks still use the analytic limits." }];
    const spiceEvidence = { spice: spice.ok ? { ok: spice.value.ok, rows: spice.value.rows, stageMs: spice.ms } : { ok: false, rows: [], stageMs: spice.ms } };
    run.reports.set(
      "EECOM",
      eecom.ok
        ? withFindings(eecom.value, [...irWarnings, ...spiceFindings], { stageMs: eecom.ms, ...spiceEvidence })
        : report("EECOM", [crashFinding("EECOM", "electrical check", eecom.error), ...irWarnings, ...spiceFindings], "The electrical check crashed.", run.hash, {
            stageMs: eecom.ms,
            ...spiceEvidence,
          }),
    );
  }

  async function firmwareBranch(run: Run, circuit: Circuit): Promise<void> {
    const { hash, revision } = run;
    const compiled = await run.stage("compile", async () =>
      (await import("@vibread/firmware")).compileSketch({ source: circuit.sketch.source, board: circuit.board.profile }),
    );
    if (!compiled.ok) {
      run.reports.set("GUIDO", report("GUIDO", [crashFinding("GUIDO", "compile", compiled.error)], "The compiler crashed.", hash));
      run.reports.set("FIDO", statusReport("FIDO", "SKIPPED", "The compiler crashed, so nothing could be simulated.", hash));
      return;
    }
    const compile: CompileResult = compiled.value;
    const { hex, elfPath: _elf, ...stored } = compile;
    run.patch.compile = stored;

    let pinModes: PinModeObservation[] = [];
    const guidoExtra: Finding[] = [];
    if (compile.ok && hex) {
      const suite = revision.suite;
      const [, observed, ran] = await Promise.all([
        run.put("app.hex", hex, "text/plain"),
        run.stage("pinModes", async () => (await import("@vibread/sim")).observePinModes({ circuit, hex })),
        suite
          ? run.stage("sim", async () => (await import("@vibread/sim")).runSuite({ circuit, hex, suite, revisionHash: hash, recordTraces: true }))
          : undefined,
      ]);
      if (observed.ok) pinModes = observed.value;
      else guidoExtra.push(crashFinding("GUIDO", "pin-mode simulation", observed.error));

      if (!ran) run.reports.set("FIDO", statusReport("FIDO", "PENDING", "Independent tests have not been written for this revision yet.", hash));
      else if (!ran.ok) run.reports.set("FIDO", report("FIDO", [crashFinding("FIDO", "simulation", ran.error)], "The simulation crashed.", hash, { stageMs: ran.ms }));
      else {
        const { traces, ...rest } = ran.value;
        await Promise.all(traces.map((trace) => run.put(`trace-${trace.scenario}.json`, JSON.stringify(trace), "application/json")));
        const traced = new Set(traces.map((t) => t.scenario));
        run.patch.sim = { ...rest, scenarios: rest.scenarios.map((s) => (traced.has(s.id) ? { ...s, traceKey: `trace-${s.id}.json` } : s)) };
        if (!pinModes.length) pinModes = rest.pinModes;
        run.reports.set("FIDO", withFindings(rest.report, [], { stageMs: ran.ms }));
      }
    } else {
      run.reports.set("FIDO", statusReport("FIDO", "SKIPPED", "Waiting for the sketch to compile.", hash));
    }

    const guido = await run.stage("guido", async () =>
      (await import("@vibread/checks")).runFirmwareChecks({ circuit, compile, pinModes, revisionHash: hash }),
    );
    run.reports.set(
      "GUIDO",
      guido.ok
        ? withFindings(guido.value, guidoExtra, { stageMs: guido.ms, compileMs: compiled.ms })
        : report("GUIDO", [crashFinding("GUIDO", "firmware check", guido.error), ...guidoExtra], "The firmware check crashed.", hash),
    );
  }

  async function stepImages(run: Run, lib: typeof AssemblyLib, circuit: Circuit, layout: NonNullable<RevisionResults["layout"]>, steps: StepList): Promise<void> {
    await mapLimit(steps.steps, IMAGE_CONCURRENCY, async (step) => {
      const view = {
        circuit,
        layout,
        steps,
        upToStep: step.n,
        highlight: { holes: step.holes, parts: step.adds.parts, jumpers: step.adds.jumpers },
      };
      const svg = lib.renderBreadboardSvg(view);
      // Focus = cropped around this step's new items (Build Mode on a phone); same width as the whole-board picture.
      const focus = lib.renderBreadboardSvg({ ...view, focus: true });
      await Promise.all([
        run.put(`step-${step.n}.svg`, svg, "image/svg+xml"),
        lib.svgToPng(svg, PNG_WIDTH).then((png) => run.put(`step-${step.n}.png`, png, "image/png")),
        lib.svgToPng(focus, PNG_WIDTH).then((png) => run.put(`step-${step.n}-focus.png`, png, "image/png")),
      ]);
    });
  }

  async function layoutBranch(run: Run, lib: typeof AssemblyLib, circuit: Circuit): Promise<void> {
    const { hash } = run;
    const laid = await run.stage("layout", () => {
      const layout = lib.layoutBoard(circuit);
      return { layout, layoutHash: lib.layoutHash(layout), lvs: lib.lvs(circuit, layout) };
    });
    if (!laid.ok) {
      run.reports.set("FAO", report("FAO", [crashFinding("FAO", "breadboard layout", laid.error)], "The breadboard layout crashed.", hash, { stageMs: laid.ms }));
      return;
    }
    const { layout, lvs } = laid.value;
    run.patch.layout = layout;
    run.patch.layoutHash = laid.value.layoutHash;
    const fao = await run.stage("fao", () => lib.assemblyReport({ circuit, layout, lvs, revisionHash: hash }));
    const faoBase = fao.ok ? fao.value : report("FAO", [crashFinding("FAO", "assembly check", fao.error)], "The assembly check crashed.", hash);
    const faoExtra: Finding[] = [];

    const stepped = await run.stage("steps", () => lib.buildSteps(circuit, layout));
    const steps = stepped.ok ? stepped.value : undefined;
    if (steps) run.patch.steps = steps;
    else if (!stepped.ok) faoExtra.push(crashFinding("FAO", "build steps", stepped.error));

    const [drawn, images] = await Promise.all([
      run.stage("breadboardSvg", () => run.put("breadboard.svg", lib.renderBreadboardSvg({ circuit, layout, ...(steps ? { steps } : {}) }), "image/svg+xml")),
      steps ? run.stage("stepImages", () => stepImages(run, lib, circuit, layout, steps)) : undefined,
    ]);
    if (!drawn.ok) faoExtra.push(crashFinding("FAO", "breadboard drawing", drawn.error));
    if (images && !images.ok) faoExtra.push(crashFinding("FAO", "step pictures", images.error));
    run.reports.set("FAO", withFindings(faoBase, faoExtra, { stageMs: (fao.ms ?? 0) + laid.ms }));
  }

  async function assemblyBranch(run: Run, circuit: Circuit): Promise<void> {
    const loaded = await run.stage("assemblyLoad", () => import("@vibread/assembly"));
    if (!loaded.ok) {
      run.reports.set("FAO", report("FAO", [crashFinding("FAO", "assembly", loaded.error)], "The assembly tools could not load.", run.hash));
      return;
    }
    const lib = loaded.value;
    const [, schematic] = await Promise.all([
      layoutBranch(run, lib, circuit),
      run.stage("schematic", async () => {
        const svg = await lib.renderSchematicSvg(circuit);
        await Promise.all([run.put("schematic.svg", svg, "image/svg+xml"), lib.svgToPng(svg, PNG_WIDTH).then((png) => run.put("schematic.png", png, "image/png"))]);
      }),
    ]);
    // The schematic is a drawing, not Go/No-Go evidence: a crash is a warning on EECOM.
    if (!schematic.ok) run.extra.EECOM.push(crashFinding("EECOM", "schematic drawing", schematic.error, "warning"));
  }

  /** Physical verification prep: self-test plan + bench firmware (never LLM-written). Failures land on GUIDO. */
  async function benchBranch(run: Run, circuit: Circuit): Promise<void> {
    const planned = await run.stage("selftest", async () => (await import("@vibread/bench")).planSelfTest(circuit, run.hash));
    if (!planned.ok) {
      run.extra.GUIDO.push(crashFinding("GUIDO", "self-test plan", planned.error));
      return;
    }
    const plan = planned.value;
    run.patch.selftest = plan;
    const bench = await run.stage("benchFirmware", async () => (await import("@vibread/firmware")).compileBenchFirmware(plan));
    if (!bench.ok) run.extra.GUIDO.push(crashFinding("GUIDO", "self-test firmware build", bench.error));
    else if (!bench.value.ok || !bench.value.hex) {
      run.extra.GUIDO.push({
        console: "GUIDO",
        ruleId: "BENCH-FW",
        severity: "error",
        title: "The self-test firmware did not compile, so the board can't be checked safely.",
        detail: bench.value.diagnostics.map((d) => d.message).join("\n").slice(0, 2000) || bench.value.log.slice(0, 2000),
      });
    } else {
      run.benchHex = bench.value.hex;
      await run.put("bench.hex", bench.value.hex, "text/plain");
    }
  }

  return {
    idle: () => faultQueue.idle(),
    async evaluate(missionId, n) {
      const revision = await store.getRevision(missionId, n);
      if (!revision) throw new Error(`Revision ${n} of mission ${missionId} does not exist.`);
      const run = new Run(store, revision);
      const { hash } = run;
      const started = performance.now();

      const parsed = parseCircuit(revision.circuit);
      if (!parsed.ok) {
        const findings: Finding[] = parsed.issues.map((i) => ({
          console: "EECOM",
          ruleId: i.code,
          severity: i.severity,
          title: i.message,
          ...(i.path ? { detail: `at ${i.path}` } : {}),
          ...(i.refs ? { refs: i.refs } : {}),
        }));
        run.reports.set("EECOM", report("EECOM", findings, "The design file has errors, so nothing else could be checked.", hash));
        for (const id of ["GUIDO", "FIDO", "FAO"] as const) run.reports.set(id, statusReport(id, "SKIPPED", "Blocked: fix the design errors first.", hash));
      } else {
        const circuit = parsed.circuit;
        const irWarnings: Finding[] = parsed.issues.map((i) => ({
          console: "EECOM",
          ruleId: i.code,
          severity: "warning",
          title: i.message,
          ...(i.refs ? { refs: i.refs } : {}),
        }));
        await Promise.all([eecomBranch(run, circuit, irWarnings), firmwareBranch(run, circuit), assemblyBranch(run, circuit), benchBranch(run, circuit)]);
      }
      run.timings.total = Math.round(performance.now() - started);

      // Keep an existing RETRO vote for this exact revision; RETRO is not deterministic and runs separately.
      const retro = revision.results.reports.find((r) => r.console === "RETRO" && r.revisionHash === hash);
      const ordered = (["EECOM", "GUIDO", "FIDO", "FAO"] as const)
        .map((id) => run.reports.get(id))
        .filter((r): r is ConsoleReport => !!r)
        .map((r) => withFindings(r, run.extra[r.console]));
      run.patch.reports = retro ? [...ordered, retro] : ordered;
      run.patch.artifacts = { ...revision.results.artifacts, ...run.artifacts };

      const saved = await store.saveResults(missionId, n, run.patch);
      // PLAN item 14: single-fault mutants for diagnosis, built in the background so the consoles never wait for them.
      const { layout, selftest } = run.patch;
      if (deps.faults !== false && parsed.ok && layout && selftest && run.benchHex) {
        faultQueue.enqueue({ missionId, n, circuit: parsed.circuit, layout, plan: selftest, benchHex: run.benchHex });
      }
      for (const r of ordered) {
        await store.appendEvent({
          missionId,
          channel: "system",
          actor: SYSTEM_ACTOR,
          kind: "console.report",
          text: `${CONSOLE_LABELS[r.console]} (${r.console}): ${r.verdict} — ${r.summary}`,
          revision: n,
          data: { console: r.console, verdict: r.verdict, errors: r.findings.filter((f) => f.severity === "error").length, timings: run.timings },
        });
      }
      return saved.results;
    },
  };
}
