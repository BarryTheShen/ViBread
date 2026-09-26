import {
  CONSOLE_LABELS,
  parseCircuit,
  type Circuit,
  type CompileResult,
  type ConsoleId,
  type ConsoleReport,
  type Finding,
  type Layout,
  type LvsResult,
  type MissionStore,
  type PinModeObservation,
  type RevisionResults,
  type SelfTestPlan,
  type SimRunResult,
  type StepList,
} from "@vibread/core";
import { SYSTEM_ACTOR, crashFinding, report, statusReport, withFindings } from "./common.js";

/** Runs every deterministic console for one revision and saves RevisionResults + artifacts (local://contracts.md). */
export interface Pipeline {
  evaluate(missionId: string, n: number): Promise<RevisionResults>;
}

type Stage<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number };

const PNG_WIDTH = 1200;

/**
 * Stage order: parse → EECOM → compile → pin modes + suite (sim) → GUIDO → FIDO → layout/LVS/FAO/steps → schematic,
 * breadboard, and per-step SVG/PNG → self-test plan + bench firmware. Every stage is timed and failure-isolated: a thrown
 * stage becomes an error finding on its console.
 *
 * Engines are imported inside their stage on purpose (not statically): a module-load failure — e.g. @tscircuit/core's
 * ESM directory-import crash outside tsx, a missing toolchain binding — must fail only that stage, never the server.
 */
export function createPipeline(deps: { store: MissionStore }): Pipeline {
  const { store } = deps;

  return {
    async evaluate(missionId, n) {
      const revision = await store.getRevision(missionId, n);
      if (!revision) throw new Error(`Revision ${n} of mission ${missionId} does not exist.`);
      const hash = revision.hash;
      const timings: Record<string, number> = {};
      const artifacts: Record<string, string> = {};
      const patch: Partial<RevisionResults> = {};

      async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<Stage<T>> {
        const started = performance.now();
        try {
          const value = await fn();
          const ms = Math.round(performance.now() - started);
          timings[name] = ms;
          return { ok: true, value, ms };
        } catch (error) {
          const ms = Math.round(performance.now() - started);
          timings[name] = ms;
          return { ok: false, error, ms };
        }
      }
      async function put(key: string, data: Uint8Array | string, contentType: string): Promise<void> {
        artifacts[key] = await store.putArtifact(data, contentType);
      }

      const parsed = parseCircuit(revision.circuit);
      const reports = new Map<ConsoleId, ConsoleReport>();

      if (!parsed.ok) {
        const findings: Finding[] = parsed.issues.map((i) => ({
          console: "EECOM",
          ruleId: i.code,
          severity: i.severity,
          title: i.message,
          ...(i.path ? { detail: `at ${i.path}` } : {}),
          ...(i.refs ? { refs: i.refs } : {}),
        }));
        reports.set("EECOM", report("EECOM", findings, "The design file has errors, so nothing else could be checked.", hash));
        for (const id of ["GUIDO", "FIDO", "FAO"] as const) reports.set(id, statusReport(id, "SKIPPED", "Blocked: fix the design errors first.", hash));
      } else {
        const circuit = parsed.circuit;
        const irWarnings: Finding[] = parsed.issues.map((i) => ({
          console: "EECOM",
          ruleId: i.code,
          severity: "warning",
          title: i.message,
          ...(i.refs ? { refs: i.refs } : {}),
        }));

        // EECOM
        const eecom = await stage("eecom", async () => (await import("@vibread/checks")).runElectricalChecks(circuit, hash));
        reports.set(
          "EECOM",
          eecom.ok
            ? withFindings(eecom.value, irWarnings, { stageMs: eecom.ms })
            : report("EECOM", [crashFinding("EECOM", "electrical check", eecom.error), ...irWarnings], "The electrical check crashed.", hash, { stageMs: eecom.ms }),
        );

        // compile
        const compiled = await stage("compile", async () =>
          (await import("@vibread/firmware")).compileSketch({ source: circuit.sketch.source, board: circuit.board.profile }),
        );
        let compile: CompileResult | undefined;
        if (compiled.ok) {
          compile = compiled.value;
          const { hex, elfPath: _elf, ...stored } = compile;
          patch.compile = stored;
          if (hex) await put("app.hex", hex, "text/plain");
        }

        // simulation: pin modes (always, for GUIDO) + the independent suite (FIDO)
        let pinModes: PinModeObservation[] = [];
        let sim: SimRunResult | undefined;
        const simFindings: Finding[] = [];
        const hex = compile?.ok ? compile.hex : undefined;
        if (hex) {
          const observed = await stage("pinModes", async () => (await import("@vibread/sim")).observePinModes({ circuit, hex }));
          if (observed.ok) pinModes = observed.value;
          else simFindings.push(crashFinding("GUIDO", "pin-mode simulation", observed.error));

          if (revision.suite) {
            const suite = revision.suite;
            const ran = await stage("sim", async () =>
              (await import("@vibread/sim")).runSuite({ circuit, hex, suite, revisionHash: hash, recordTraces: true }),
            );
            if (ran.ok) {
              sim = ran.value;
              const traceKeys = new Map<string, string>();
              for (const trace of sim.traces) {
                const key = `trace-${trace.scenario}.json`;
                await put(key, JSON.stringify(trace), "application/json");
                traceKeys.set(trace.scenario, key);
              }
              const { traces: _traces, ...rest } = sim;
              patch.sim = {
                ...rest,
                scenarios: rest.scenarios.map((s) => (traceKeys.has(s.id) ? { ...s, traceKey: traceKeys.get(s.id) } : s)),
              };
              if (!pinModes.length) pinModes = sim.pinModes;
              reports.set("FIDO", withFindings(sim.report, [], { stageMs: ran.ms }));
            } else {
              reports.set("FIDO", report("FIDO", [crashFinding("FIDO", "simulation", ran.error)], "The simulation crashed.", hash, { stageMs: ran.ms }));
            }
          } else {
            reports.set("FIDO", statusReport("FIDO", "PENDING", "Independent tests have not been written for this revision yet.", hash));
          }
        } else {
          reports.set(
            "FIDO",
            statusReport("FIDO", "SKIPPED", compiled.ok ? "Waiting for the sketch to compile." : "The compiler crashed, so nothing could be simulated.", hash),
          );
        }

        // GUIDO
        if (compile) {
          const firmware = compile;
          const guido = await stage("guido", async () =>
            (await import("@vibread/checks")).runFirmwareChecks({ circuit, compile: firmware, pinModes, revisionHash: hash }),
          );
          reports.set(
            "GUIDO",
            guido.ok
              ? withFindings(guido.value, simFindings, { stageMs: guido.ms, compileMs: compiled.ms })
              : report("GUIDO", [crashFinding("GUIDO", "firmware check", guido.error), ...simFindings], "The firmware check crashed.", hash),
          );
        } else {
          reports.set("GUIDO", report("GUIDO", [crashFinding("GUIDO", "compile", compiled.ok ? "no result" : compiled.error)], "The compiler crashed.", hash));
        }

        // FAO: layout, LVS, assembly report, steps, drawings
        const faoExtra: Finding[] = [];
        const loaded = await stage("assemblyLoad", () => import("@vibread/assembly"));
        if (!loaded.ok) {
          reports.set("FAO", report("FAO", [crashFinding("FAO", "assembly", loaded.error)], "The assembly tools could not load.", hash));
        } else {
          const lib = loaded.value;
          const laid = await stage("layout", () => {
            const layout: Layout = lib.layoutBoard(circuit);
            const lvsResult: LvsResult = lib.lvs(circuit, layout);
            return { layout, layoutHash: lib.layoutHash(layout), lvs: lvsResult };
          });
          if (!laid.ok) {
            reports.set("FAO", report("FAO", [crashFinding("FAO", "breadboard layout", laid.error)], "The breadboard layout crashed.", hash, { stageMs: laid.ms }));
          } else {
            const { layout, lvs: lvsResult } = laid.value;
            patch.layout = layout;
            patch.layoutHash = laid.value.layoutHash;
            const fao = await stage("fao", () => lib.assemblyReport({ circuit, layout, lvs: lvsResult, revisionHash: hash }));
            const faoBase = fao.ok ? fao.value : report("FAO", [crashFinding("FAO", "assembly check", fao.error)], "The assembly check crashed.", hash);

            const stepped = await stage("steps", () => lib.buildSteps(circuit, layout));
            let steps: StepList | undefined;
            if (stepped.ok) {
              steps = stepped.value;
              patch.steps = steps;
            } else faoExtra.push(crashFinding("FAO", "build steps", stepped.error));

            const drawn = await stage("breadboardSvg", async () => {
              const svg = lib.renderBreadboardSvg({ circuit, layout, ...(steps ? { steps } : {}) });
              await put("breadboard.svg", svg, "image/svg+xml");
            });
            if (!drawn.ok) faoExtra.push(crashFinding("FAO", "breadboard drawing", drawn.error));

            if (steps) {
              const stepList = steps;
              const images = await stage("stepImages", async () => {
                for (const step of stepList.steps) {
                  const svg = lib.renderBreadboardSvg({
                    circuit,
                    layout,
                    steps: stepList,
                    upToStep: step.n,
                    highlight: { holes: step.holes, parts: step.adds.parts, jumpers: step.adds.jumpers },
                  });
                  await put(`step-${step.n}.svg`, svg, "image/svg+xml");
                  await put(`step-${step.n}.png`, await lib.svgToPng(svg, PNG_WIDTH), "image/png");
                }
              });
              if (!images.ok) faoExtra.push(crashFinding("FAO", "step pictures", images.error));
            }
            reports.set("FAO", withFindings(faoBase, faoExtra, { stageMs: (fao.ms ?? 0) + laid.ms }));
          }

          // Schematic is a drawing, not Go/No-Go evidence: a crash is a warning on EECOM.
          const schematic = await stage("schematic", async () => {
            const svg = await lib.renderSchematicSvg(circuit);
            await put("schematic.svg", svg, "image/svg+xml");
            await put("schematic.png", await lib.svgToPng(svg, PNG_WIDTH), "image/png");
          });
          if (!schematic.ok) {
            const current = reports.get("EECOM");
            if (current) reports.set("EECOM", withFindings(current, [crashFinding("EECOM", "schematic drawing", schematic.error, "warning")]));
          }
        }

        // Physical verification prep: self-test plan + bench firmware (never LLM-written).
        const guidoExtra: Finding[] = [];
        const planned = await stage("selftest", async () => (await import("@vibread/bench")).planSelfTest(circuit, hash));
        if (planned.ok) {
          const plan: SelfTestPlan = planned.value;
          patch.selftest = plan;
          const bench = await stage("benchFirmware", async () => (await import("@vibread/firmware")).compileBenchFirmware(plan));
          if (!bench.ok) guidoExtra.push(crashFinding("GUIDO", "self-test firmware build", bench.error));
          else if (!bench.value.ok || !bench.value.hex) {
            guidoExtra.push({
              console: "GUIDO",
              ruleId: "BENCH-FW",
              severity: "error",
              title: "The self-test firmware did not compile, so the board can't be checked safely.",
              detail: bench.value.diagnostics.map((d) => d.message).join("\n").slice(0, 2000) || bench.value.log.slice(0, 2000),
            });
          } else await put("bench.hex", bench.value.hex, "text/plain");
        } else guidoExtra.push(crashFinding("GUIDO", "self-test plan", planned.error));
        const guidoReport = reports.get("GUIDO");
        if (guidoReport && guidoExtra.length) reports.set("GUIDO", withFindings(guidoReport, guidoExtra));
      }

      // Keep an existing RETRO vote for this exact revision; RETRO is not deterministic and runs separately.
      const retro = revision.results.reports.find((r) => r.console === "RETRO" && r.revisionHash === hash);
      const ordered = (["EECOM", "GUIDO", "FIDO", "FAO"] as const).map((id) => reports.get(id)).filter((r): r is ConsoleReport => !!r);
      patch.reports = retro ? [...ordered, retro] : ordered;
      patch.artifacts = { ...revision.results.artifacts, ...artifacts };

      const saved = await store.saveResults(missionId, n, patch);
      for (const r of ordered) {
        await store.appendEvent({
          missionId,
          channel: "system",
          actor: SYSTEM_ACTOR,
          kind: "console.report",
          text: `${CONSOLE_LABELS[r.console]} (${r.console}): ${r.verdict} — ${r.summary}`,
          revision: n,
          data: { console: r.console, verdict: r.verdict, errors: r.findings.filter((f) => f.severity === "error").length, timings },
        });
      }
      return saved.results;
    },
  };
}
