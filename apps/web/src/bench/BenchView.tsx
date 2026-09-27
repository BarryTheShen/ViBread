import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Link, useSearchParams } from "react-router";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import Typography from "@mui/material/Typography";
import type { BenchRunResult, BoardProfileId, BuildState, Circuit, DeviceLine, Layout, MissionDetail, RevisionDetail, SelfTestPlan } from "@vibread/core";
import { BOARD_PROFILES, revisionHash } from "@vibread/core";
import { FAULTS, evaluateRun, planSelfTest, promptFor } from "@vibread/bench";
import { BenchRunner, BoardCheckError, type BenchRunnerState } from "./runner.js";
import { benchRuntime, createBenchLog } from "./benchLog.js";
import { applyBrowserFault, circuitWithFault } from "./faults.js";
import { decorateBreadboardSvg, fallbackBreadboardSvg, candidateHighlight, type SvgHighlight } from "./svg.js";
import {
  classifySerialError,
  describePort,
  flashHex,
  requestBoardPort,
  TELEMETRY_BAUD,
  UnsupportedWebSerialError,
  type BoardPortConnection,
  type FlashProgress,
} from "./serial.js";
import { createTelemetryStore, faultLabel, VirtualBenchTransport, type TelemetryStore, type VirtualFault } from "./virtual.js";
import { BenchAskBridge, type RemoteAskStatus } from "./askBridge.js";
import { approvalGate } from "./approval.js";
import { MONO_FONT } from "../theme.js";
import { SerialMonitor } from "../components/SerialMonitor.js";
import { parseBenchQuery, testLabel } from "./query.js";
import { nativeFlash, useBenchPorts } from "./nativeFlash.js";

const STEPS = ["Connect your board", "Make it safe", "Check power", "Test each part", "Find the problem", "Run your project", "Celebrate"];
const BOARD_LOST_POWER = "The board lost power or stopped answering when you plugged in — unplug now and check for a short between the red + and blue − rails, or a part bridging them.";
/** The power check's watchdog: past the runner's own worst case (3 hello requests 2 s apart, then 5 s for VCC). */
const RAIL_WATCHDOG_MS = 13_000;

interface FirmwareResponse {
  hex: string;
  design?: string;
  plan?: SelfTestPlan;
  fallbackUpload?: { command: string; args: string[] };
}

interface BenchApprovalRequest {
  id: string;
  action: "flash-bench" | "rail-checkpoint" | "run-selftest" | "flash-app";
  summary: string;
  note?: string;
  revision: number;
  status: "pending" | "approved";
  requestedBy: { name?: string; id: string; channel: string };
  preApprovedBy?: { name?: string; channel: string };
  createdAt: string;
  expiresAt: string;
}

interface LoadedBench {
  mission: MissionDetail;
  revision: RevisionDetail;
  plan: SelfTestPlan;
  layout?: Layout;
  boardSvg: string;
}

interface BenchRunResponse extends BenchRunResult {
  [key: string]: unknown;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error?: { message?: string } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return body as T;
}

async function firmwareFor(missionId: string, kind: "bench" | "app"): Promise<FirmwareResponse> {
  const firmware = await readJson<FirmwareResponse>(`/api/missions/${encodeURIComponent(missionId)}/bench/firmware`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (typeof firmware.hex !== "string" || firmware.hex.length === 0) throw new Error("The server did not return a firmware HEX file.");
  return firmware;
}

async function loadBench(missionId: string): Promise<LoadedBench> {
  const mission = await readJson<MissionDetail>(`/api/missions/${encodeURIComponent(missionId)}`);
  const revisionNumber = mission.released?.n ?? mission.revision?.n ?? mission.mission.currentRevision;
  if (!revisionNumber) throw new Error("This mission has no released revision to verify yet.");
  const revision = await readJson<RevisionDetail>(`/api/missions/${encodeURIComponent(missionId)}/revisions/${revisionNumber}`);
  const hash = revision.hash || revisionHash(revision.circuit, revision.suite);
  const plan = revision.results.selftest ?? planSelfTest(revision.circuit, hash);
  let boardSvg = fallbackBreadboardSvg(revision.circuit.parts.map((part) => part.id));
  // The finished board with the builder's wire colours when this is the build target; else the pipeline drawing.
  const build = await readJson<BuildState>(`/api/missions/${encodeURIComponent(missionId)}/build`).catch(() => undefined);
  const coloredUrl = build?.revision === revisionNumber ? build.wires?.breadboardUrl : undefined;
  const artifactUrl = coloredUrl ?? revision.artifactUrls["breadboard.svg"] ?? revision.artifactUrls["breadboard"];
  if (artifactUrl) {
    try {
      const response = await fetch(artifactUrl);
      if (response.ok) {
        const candidate = await response.text();
        if (/<svg[\s>]/i.test(candidate)) boardSvg = candidate;
      }
    } catch {
      // Keep the deterministic local board only when the optional artifact is unavailable.
    }
  }
  return { mission, revision, plan, layout: revision.results.layout, boardSvg };
}

function progressText(progress: FlashProgress | undefined): string {
  if (!progress) return "Preparing the bootloader…";
  return `${progress.stage} · ${Math.round(progress.percent)}%`;
}
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function fallbackCommand(upload: { command: string; args: string[] }): string {
  return [shellQuote(upload.command), ...upload.args.map(shellQuote)].join(" ");
}

function serialPresentation(error: unknown): { message: string; technical: string } {
  const failure = classifySerialError(error);
  return { message: failure.kind === "disconnect" ? BOARD_LOST_POWER : failure.message, technical: failure.technical };
}
function virtualPromptHint(ask: Extract<DeviceLine, { t: "ask" }>): string | undefined {
  const part = ask.part ?? "that part";
  const hints: Record<string, string> = {
    "press-hold": `ViBread's virtual hand is holding ${part}.`,
    release: `ViBread's virtual hand released ${part}.`,
    cover: `ViBread's virtual hand is covering ${part}.`,
    uncover: `ViBread's virtual hand uncovered ${part}.`,
    "knob-min": `ViBread's virtual hand turned ${part} to minimum.`,
    "knob-max": `ViBread's virtual hand turned ${part} to maximum.`,
  };
  return hints[ask.kind];
}
function promptTitle(ask: Extract<DeviceLine, { t: "ask" }>, plan: SelfTestPlan, fallback: string): string {
  const subject = plan.subjects.find((candidate) => candidate.part === ask.part);
  if (ask.kind === "which-led" && subject?.kind === "led") return `${subject.label}: ${fallback}`;
  return subject === undefined ? fallback : `${subject.label}: ${fallback}`;
}
function cleanTelemetryLog(lines: string[]): string[] {
  const cleaned: string[] = [];
  let railsRuns = 0;
  let skipRails = false;
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      cleaned.push(raw);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || !("t" in parsed)) {
      cleaned.push(raw);
      continue;
    }
    const line = parsed as { t?: unknown; test?: unknown };
    if (line.t === "hello" && cleaned.at(-1) === raw) continue;
    if (line.t === "begin" && line.test === "rails.vcc") {
      railsRuns += 1;
      if (railsRuns > 1) {
        skipRails = true;
        continue;
      }
    }
    if (skipRails) {
      if (line.t === "end" && line.test === "rails.vcc") skipRails = false;
      continue;
    }
    cleaned.push(raw);
  }
  return cleaned;
}

const actionButtonSx = { minHeight: 46, borderRadius: 2 } as const;
/** Rows sit side by side only when the bench itself (the mission panel, a size container) is wide enough. */
const WIDE_PANEL = "@container (min-width: 760px)";

/** The breadboard drawing with the highlighted fault area and, on the virtual board, the parts' live state. */
function DecoratedBoard({ svg, highlight, telemetry, sx }: { svg: string; highlight: SvgHighlight; telemetry: TelemetryStore; sx: SxProps<Theme> }): ReactElement {
  const parts = useSyncExternalStore(telemetry.subscribe, telemetry.get)?.parts;
  const html = useMemo(() => decorateBreadboardSvg(svg, highlight, parts), [svg, highlight, parts]);
  return <Box sx={sx} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The bench as a view of the mission panel (`/m/:id?panel=bench`, issue #24): flash and self-test the build target on a
 * USB board or the virtual board. `?tests=&returnTo=` (from a build step's checkpoint) scope it to those tests. Every
 * physical action still waits for an explicit click here.
 */
export function BenchView({ missionId }: { missionId: string }): ReactElement | null {
  const [searchParams] = useSearchParams();
  const benchQuery = useMemo(() => parseBenchQuery(searchParams.toString()), [searchParams]);
  const subsetTests = benchQuery.tests;
  const [loaded, setLoaded] = useState<LoadedBench | undefined>();
  const [loadError, setLoadError] = useState<string>();
  const [authRequired, setAuthRequired] = useState(false);
  const [mode, setMode] = useState<"physical" | "virtual">("virtual");
  const [boardProfileChoice, setBoardProfileChoice] = useState<BoardProfileId | "auto">("auto");
  const [fault, setFault] = useState<VirtualFault>("none");
  const [activeStep, setActiveStep] = useState(0);
  const [connection, setConnection] = useState<BoardPortConnection | undefined>();
  const [runnerState, setRunnerState] = useState<BenchRunnerState>();
  const [runner, setRunner] = useState<BenchRunner>();
  const [benchHex, setBenchHex] = useState<string>();
  const [fallbackUpload, setFallbackUpload] = useState<{ command: string; args: string[] }>();
  const [flashProgress, setFlashProgress] = useState<FlashProgress>();
  // Telemetry lives outside React state: only the board drawings subscribe, so readings never re-render the page.
  const [telemetry] = useState(createTelemetryStore);
  const [run, setRun] = useState<BenchRunResult>();
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [highlight, setHighlight] = useState<SvgHighlight>({ holes: [], parts: [], jumpers: [] });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [technicalError, setTechnicalError] = useState<string>();
  /** A failure that retrying the same step can't fix: a new flash ("Flash again") or a new port ("Choose the port again"). */
  const [errorFix, setErrorFix] = useState<"flash" | "reconnect">();
  /** Native flashing (the ViBread server's arduino-cli/avrdude on this computer): ports, the chosen one, its output. */
  const native = useBenchPorts(mode === "physical", connection?.port.getInfo());
  const [nativeOutput, setNativeOutput] = useState<string>();
  /** After a native flash the Web Serial port didn't come back: a click (a user gesture) picks it again. */
  const [needsReconnect, setNeedsReconnect] = useState(false);
  /** The last native flash failed: the error's retry repeats it with avrdude, not the browser flash. */
  const [nativeFailed, setNativeFailed] = useState<{ which: "bench" | "app"; message: string }>();
  const lastRunnerError = useRef<string | undefined>(undefined);
  const benchLog = useMemo(() => createBenchLog(missionId), [missionId]);
  const log = benchLog.log;
  useEffect(() => () => void benchLog.flush(), [benchLog]);
  const [remoteAnswer, setRemoteAnswer] = useState<{ id: string; value: string; by: string }>();
  const [requests, setRequests] = useState<BenchApprovalRequest[]>([]);
  const askBridgeRef = useRef<Map<string, BenchAskBridge>>(new Map());
  const [reducedMotion, setReducedMotion] = useState(false);
  const virtualRef = useRef<VirtualBenchTransport | undefined>(undefined);
  const connectionRef = useRef<BoardPortConnection | undefined>(undefined);
  const runnerRef = useRef<BenchRunner | undefined>(undefined);
  /** When "Check board power" was clicked; the power watchdog runs only from a real request. */
  const [railRequestAt, setRailRequestAt] = useState<number | undefined>(undefined);
  const currentAskIdForBridge = runnerState?.asks[0]?.id;
  const currentAskValue = currentAskIdForBridge === undefined ? undefined : runnerState?.answers[currentAskIdForBridge];

  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    setAuthRequired(false);
    if (!missionId) {
      setLoadError("No mission was selected.");
      return () => undefined;
    }
    loadBench(missionId)
      .then((value) => {
        if (alive) {
          setLoaded(value);
          setFallbackUpload(value.revision.fallbackUpload);
        }
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (alive && /401|unauthori[sz]ed|sign in|required/i.test(message)) {
          setAuthRequired(true);
          setLoadError(undefined);
        } else if (alive) {
          setLoadError(message);
        }
      });
    return () => {
      alive = false;
      runnerRef.current?.dispose();
      void connectionRef.current?.transport.close();
      void virtualRef.current?.close();
    };
  }, [missionId]);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      if (!missionId) return;
      try {
        const result = await readJson<{ requests: BenchApprovalRequest[] }>(`/api/missions/${encodeURIComponent(missionId)}/bench/requests`);
        if (alive) setRequests(result.requests.filter((request) => request.status === "pending" || request.status === "approved"));
      } catch {
        // Approval polling is advisory; the local bench stays usable.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [missionId]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    if (!loaded || !currentAskIdForBridge || currentAskValue !== undefined) return undefined;
    const ask = runnerState?.asks[0];
    if (!ask) return undefined;
    const bridge = new BenchAskBridge(missionId);
    askBridgeRef.current.set(ask.id, bridge);
    setRemoteAnswer(undefined);
    const prompt = promptFor(ask, loaded.plan);
    void bridge.publish(ask, prompt).catch(() => undefined);
    let active = true;
    let polling = false;
    const poll = async (): Promise<void> => {
      if (!active || polling) return;
      polling = true;
      try {
        const status = await bridge.poll(ask.id);
        if (active && status.status === "answered" && typeof status.answer === "string") {
          active = false;
          const by = status.answeredBy?.name ?? "iMessage";
          setRemoteAnswer({ id: ask.id, value: status.answer, by });
          try {
            await runnerRef.current?.answer(ask.id, status.answer);
          } catch {
            // A local answer won the race; the server's first-answer contract keeps it authoritative.
          }
        }
      } catch {
        // CAPCOM is advisory; the local prompt remains usable when polling fails.
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      askBridgeRef.current.delete(ask.id);
    };
  }, [currentAskIdForBridge, currentAskValue, loaded, missionId]);

  useEffect(() => {
    if (!currentAskIdForBridge || currentAskValue === undefined) return;
    void askBridgeRef.current.get(currentAskIdForBridge)?.close(currentAskIdForBridge, currentAskValue).catch(() => undefined);
  }, [currentAskIdForBridge, currentAskValue]);

  useEffect(() => {
    if (activeStep !== 2 || railRequestAt === undefined) return undefined;
    const timer = window.setTimeout(() => {
      const current = runnerRef.current?.state;
      if (!current?.seenHello || !current.seenVcc) {
        const message = current?.seenHello ? "The board did not report VCC. Check the board power and retry." : "The board did not answer the power check. Check the cable and retry.";
        current && runnerRef.current?.fail(message);
        setError(message);
      }
    }, RAIL_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [activeStep, railRequestAt]);

  useEffect(() => {
    const candidate = run?.diagnosis.candidates[selectedCandidate];
    setHighlight(candidateHighlight(candidate));
  }, [run, selectedCandidate]);

  const attachRunner = useCallback((nextTransport: BoardPortConnection["transport"] | VirtualBenchTransport, plan: SelfTestPlan, circuit: Circuit, revision: number): BenchRunner => {
    runnerRef.current?.dispose();
    const virtual = nextTransport instanceof VirtualBenchTransport;
    const nextRunner = new BenchRunner({
      plan,
      circuit,
      revision,
      runId: virtual ? `virtual-${Date.now().toString(36)}` : undefined,
      transport: nextTransport,
      ...(virtual ? {} : { log }),
      onState: (next) => {
        setRunnerState({ ...next });
        // Only a new runner error is shown; later lines must not bring back an alert the person closed.
        if (next.error !== lastRunnerError.current && next.error) {
          const presented = serialPresentation(next.error);
          setError(presented.message);
          setTechnicalError(presented.technical);
        }
        lastRunnerError.current = next.error;
      },
    });
    runnerRef.current = nextRunner;
    setRunner(nextRunner);
    setRunnerState(nextRunner.state);
    return nextRunner;
  }, [log]);

  const connectPhysical = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId) return;
    setBusy("connect");
    setError(undefined);
    setTechnicalError(undefined);
    try {
      // Logged before the port picker, so a report shows where the bench ran even when choosing a port fails.
      log("info", "connect: bench runtime", benchRuntime());
      const picked = await requestBoardPort({
        log,
        onDisconnect: () => {
          log("error", "serial: port disconnected (USB unplugged or the board reset its USB bridge)");
          runnerRef.current?.fail("The board connection was lost.");
          setError(BOARD_LOST_POWER);
          setTechnicalError("The serial port fired 'disconnect': the board's USB connection dropped (unplugged, or a short made the board reset its USB bridge).");
          setErrorFix("reconnect");
        },
      });
      const selected = boardProfileChoice === "auto" ? picked : { ...picked, profile: BOARD_PROFILES[boardProfileChoice] };
      connectionRef.current = selected;
      setConnection(selected);
      attachRunner(selected.transport, loaded.plan, loaded.revision.circuit, loaded.revision.n);
      setActiveStep(1);
      // Listen at the bench firmware's speed right away: a board that already runs this design's safe firmware (flashed
      // earlier, or with the Arduino IDE / arduino-cli fallback) says hello within a couple of seconds.
      log("info", `connect: ${describePort(selected)} (profile ${selected.profile.id}, bootloader ${selected.profile.flash.baud}); open port at ${TELEMETRY_BAUD} baud`);
      try {
        await selected.transport.open(TELEMETRY_BAUD);
      } catch (reason: unknown) {
        const failure = classifySerialError(reason);
        log("error", `connect: open failed — ${failure.kind}`, { error: failure.technical });
        setError(failure.message);
        setTechnicalError(failure.technical);
      }
    } catch (reason: unknown) {
      if (reason instanceof UnsupportedWebSerialError) setError("Web Serial is unavailable. Use Chrome or Edge on the laptop; Firefox is not supported here.");
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [attachRunner, boardProfileChoice, loaded, log, missionId]);

  const connectVirtual = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId) return;
    setBusy("connect");
    setError(undefined);
    try {
      const firmware = await firmwareFor(missionId, "bench");
      setBenchHex(firmware.hex);
      setFallbackUpload(firmware.fallbackUpload);
      const virtual = new VirtualBenchTransport({
        onTelemetry: telemetry.set,
        onError: (message) => {
          setError(message);
          runnerRef.current?.fail(message);
        },
      });
      const simulatedCircuit = circuitWithFault(loaded.revision.circuit, fault, loaded.layout);
      const nextRunner = attachRunner(virtual, loaded.plan, simulatedCircuit, loaded.revision.n);
      virtualRef.current = virtual;
      virtual.start({ circuit: simulatedCircuit, hex: firmware.hex, fault });
      setActiveStep(1);
      // The virtual path still walks the safety sequence, but never toggles a USB port.
      setRunner(nextRunner);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [attachRunner, fault, loaded, missionId]);

  const connect = mode === "physical" ? connectPhysical : connectVirtual;

  const flashSafe = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId || !runner) return;
    setBusy("safe");
    setError(undefined);
    setTechnicalError(undefined);
    setErrorFix(undefined);
    setFlashProgress(undefined);
    try {
      const firmware = benchHex ? { hex: benchHex, fallbackUpload } : await firmwareFor(missionId, "bench");
      setBenchHex(firmware.hex);
      setFallbackUpload(firmware.fallbackUpload);
      if (mode === "physical") {
        const selected = connectionRef.current;
        if (!selected) throw new Error("Connect the board before flashing safe firmware.");
        log("info", `flash: safe firmware for design ${loaded.plan.design} on ${selected.profile.name}`);
        const flashed = await flashHex({ connection: selected, hex: firmware.hex, onProgress: setFlashProgress, onBoundary: () => runnerRef.current?.markFlashBoundary(), log });
        log("info", `flash: done — ${flashed.bytes} bytes at ${flashed.baud} baud; ${flashed.reopened ? "waiting for the new firmware's hello" : "the port didn't reopen"}`);
        setFlashProgress({
          stage: flashed.reopened
            ? `Flashed and verified ✓ (${flashed.bytes.toLocaleString()} bytes at ${flashed.baud})`
            : "Firmware written and verified ✓; the USB port didn't reopen — unplug and replug the board, then Check board power",
          percent: 100,
        });
      } else {
        setFlashProgress({ stage: "Virtual flash skipped", percent: 100 });
      }
      setRailRequestAt(undefined);
      setActiveStep(2);
    } catch (reason: unknown) {
      const failure = classifySerialError(reason);
      log("error", `flash: failed — ${failure.kind}`, { error: failure.technical });
      setError(failure.kind === "disconnect" ? BOARD_LOST_POWER : failure.message);
      setTechnicalError(failure.technical);
      if (failure.kind === "disconnect") setErrorFix("reconnect");
    } finally {
      setBusy(undefined);
    }
  }, [benchHex, fallbackUpload, loaded, log, missionId, mode, runner]);

  /** The board already says hello for this design at connect: its safe firmware is on it, so the flash is optional. */
  const skipFlash = useCallback((): void => {
    const hello = runnerRef.current?.matchingHello;
    if (!hello) return;
    log("info", `flash: skipped — board already runs design ${hello.design} (${hello.board})`);
    setError(undefined);
    setTechnicalError(undefined);
    setFlashProgress({ stage: "Already running this design's safe firmware — flash skipped", percent: 100 });
    setRailRequestAt(undefined);
    setActiveStep(2);
  }, [log]);

  const startRail = useCallback(async (): Promise<void> => {
    if (!runner) return;
    setBusy("rail");
    setError(undefined);
    setTechnicalError(undefined);
    setErrorFix(undefined);
    setRailRequestAt(Date.now());
    try {
      // After a flash whose reopen failed (the child unplugged and replugged the board), open the port again here.
      const selected = mode === "physical" ? connectionRef.current : undefined;
      if (selected && !selected.transport.isOpen) {
        log("info", `serial: opening the port at ${TELEMETRY_BAUD} baud for the power check`);
        await selected.transport.open(TELEMETRY_BAUD);
      }
      await runner.startRail();
    } catch (reason: unknown) {
      const presented = serialPresentation(reason);
      if (mode === "physical") log("error", `power check: failed — ${presented.message}`, { error: presented.technical });
      runner.fail(presented.message);
      setError(presented.message);
      setTechnicalError(presented.technical);
      const kind = classifySerialError(reason).kind;
      setErrorFix(reason instanceof BoardCheckError ? "flash" : kind === "disconnect" || kind === "open-failed" || kind === "not-open" ? "reconnect" : undefined);
    } finally {
      setRailRequestAt(undefined);
      setBusy(undefined);
    }
  }, [log, mode, runner]);

  const startSelfTest = useCallback(async (): Promise<void> => {
    if (!runner || !runnerState?.seenHello || !runnerState.seenVcc) return;
    setBusy("selftest");
    setError(undefined);
    setRun(undefined);
    setSelectedCandidate(0);
    try {
      setActiveStep(3);
      await runner.startSelfTest(subsetTests.length > 0 ? subsetTests : undefined);
    } catch (reason: unknown) {
      const presented = serialPresentation(reason);
      runner.fail(presented.message);
      setError(presented.message);
      setTechnicalError(presented.technical);
    } finally {
      setBusy(undefined);
    }
  }, [runner, runnerState, subsetTests]);

  const submitRun = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId || !runner) return;
    setBusy("diagnose");
    setError(undefined);
    try {
      const request = runner.runRequest();
      let result: BenchRunResult;
      try {
        result = await readJson<BenchRunResponse>(`/api/missions/${encodeURIComponent(missionId)}/bench/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, runId: runner.runId, ...(benchQuery.step ? { step: benchQuery.step } : {}) }),
        });
      } catch (serverReason: unknown) {
        if (mode !== "virtual") throw serverReason;
        result = await evaluateRun({
          circuit: loaded.revision.circuit,
          plan: request.plan,
          lines: request.lines,
          answers: request.answers,
          kind: request.kind,
          revision: request.revision,

          runId: runner.runId,
        });
        if (benchQuery.step) result.step = benchQuery.step;
      }
      setRun(result);
      setSelectedCandidate(0);
      setActiveStep(4);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [loaded, missionId, mode, runner, benchQuery.step]);
  const downloadFirmware = useCallback(async (kind: "bench" | "app"): Promise<void> => {
    if (!missionId) return;
    setBusy(`download:${kind}`);
    try {
      const firmware = await firmwareFor(missionId, kind);
      setFallbackUpload(firmware.fallbackUpload);
      const url = URL.createObjectURL(new Blob([firmware.hex], { type: "text/plain" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${kind}.hex`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [missionId]);

  useEffect(() => {
    if (runnerState?.done && activeStep === 3 && !busy && !run) void submitRun();
  }, [activeStep, busy, run, runnerState, submitRun]);

  const flashApp = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId) return;
    setBusy("app");
    setError(undefined);
    setFlashProgress(undefined);
    try {
      const firmware = await firmwareFor(missionId, "app");
      setFallbackUpload(firmware.fallbackUpload);
      if (mode === "physical") {
        const selected = connectionRef.current;
        if (!selected) throw new Error("Connect the board before flashing app firmware.");
        log("info", `flash: your project's firmware on ${selected.profile.name}`);
        const flashed = await flashHex({ connection: selected, hex: firmware.hex, onProgress: setFlashProgress, onBoundary: () => runnerRef.current?.markFlashBoundary(), log });
        log("info", `flash: done — ${flashed.bytes} bytes at ${flashed.baud} baud${flashed.reopened ? "" : "; the port didn't reopen"}`);
        setFlashProgress({
          stage: flashed.reopened
            ? `Flashed and verified ✓ (${flashed.bytes.toLocaleString()} bytes at ${flashed.baud})`
            : "Your firmware is written and verified ✓; the USB port didn't reopen — unplug and replug the board to watch its serial output",
          percent: 100,
        });
      } else {
        if (!virtualRef.current) throw new Error("Connect the virtual board before running app firmware.");
        runnerRef.current?.dispose();
        virtualRef.current.start({ circuit: loaded.revision.circuit, hex: firmware.hex, fault: "none" });
        setRunner(undefined);
        setRunnerState(undefined);
        telemetry.set(undefined);
        setFlashProgress({ stage: "Virtual app firmware running", percent: 100 });
      }
      setActiveStep(6);
    } catch (reason: unknown) {
      const failure = classifySerialError(reason);
      if (mode === "physical") log("error", `flash: failed — ${failure.kind}`, { error: failure.technical });
      setError(failure.kind === "disconnect" ? BOARD_LOST_POWER : failure.message);
      setTechnicalError(failure.technical);
      if (failure.kind === "disconnect") setErrorFix("reconnect");
    } finally {
      setBusy(undefined);
    }
  }, [loaded, log, missionId, mode]);

  /** Give the port back to Web Serial after avrdude used it; the runner keeps listening across close/open. */
  const reopenWebSerial = useCallback(async (selected: BoardPortConnection | undefined): Promise<boolean> => {
    if (!selected || selected.transport.disconnected) return false;
    if (selected.transport.isOpen) return true;
    try {
      await selected.transport.open(TELEMETRY_BAUD);
      log("info", `native flash: Web Serial reopened at ${TELEMETRY_BAUD} baud`);
      return true;
    } catch (reason: unknown) {
      log("warn", "native flash: Web Serial did not reopen", { error: classifySerialError(reason).technical });
      return false;
    }
  }, [log]);

  /**
   * Flash with ViBread's own uploader (issue #20): the server on this computer runs arduino-cli → avrdude, the same
   * upload the Arduino IDE does. avrdude needs the port, so Web Serial closes first and reopens afterwards.
   */
  const flashNativeFirmware = useCallback(async (which: "bench" | "app"): Promise<void> => {
    const port = native.port;
    if (!loaded || !missionId || !port) return;
    setBusy(`native:${which}`);
    setError(undefined);
    setTechnicalError(undefined);
    setErrorFix(undefined);
    setFlashProgress(undefined);
    setNativeOutput(undefined);
    setNeedsReconnect(false);
    setNativeFailed(undefined);
    const selected = connectionRef.current;
    try {
      if (selected?.transport.isOpen) {
        log("info", `native flash: closing Web Serial so avrdude can open ${port}`);
        await selected.transport.close();
      }
      log("info", `native flash: ${which} firmware → ${port} with ViBread's uploader (arduino-cli / avrdude)`);
      const result = await nativeFlash(missionId, { port, which, ...(boardProfileChoice === "auto" ? {} : { board: boardProfileChoice }) });
      setNativeOutput(result.output || undefined);
      if (!result.ok) {
        log("error", `native flash: failed — ${result.error.code}`, { error: result.error.message });
        const message = result.error.hint ? `${result.error.message} ${result.error.hint}` : result.error.message;
        setError(message);
        setNativeFailed({ which, message });
        setTechnicalError(result.output.split(/\r?\n/).filter((line) => line.trim()).slice(-12).join("\n") || undefined);
        // Nothing was written: hand the port back so the browser path and the checks stay usable.
        await reopenWebSerial(selected);
        return;
      }
      log("info", `native flash: done in ${result.durationMs} ms (${result.fqbn}); waiting for the new firmware's hello`);
      runnerRef.current?.markFlashBoundary();
      setFlashProgress({ stage: "Flashed ✓ (avrdude)", percent: 100 });
      const reopened = await reopenWebSerial(selected);
      if (which === "bench") {
        setNeedsReconnect(!reopened);
        setRailRequestAt(undefined);
        setActiveStep(2);
      } else {
        setActiveStep(6);
      }
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      log("error", "native flash: request failed", { error: message });
      setError(`ViBread's uploader could not run: ${message}`);
      setNativeFailed({ which, message: `ViBread's uploader could not run: ${message}` });
      await reopenWebSerial(selected);
    } finally {
      setBusy(undefined);
    }
  }, [boardProfileChoice, loaded, log, missionId, native.port, reopenWebSerial]);

  /** Pick the board's port again after a native flash (the chooser needs this click); stays on the current step. */
  const reconnectAfterNativeFlash = useCallback(async (): Promise<void> => {
    const step = activeStep;
    runnerRef.current?.dispose();
    runnerRef.current = undefined;
    void connectionRef.current?.transport.close().catch(() => undefined);
    connectionRef.current = undefined;
    setConnection(undefined);
    await connectPhysical();
    if (!connectionRef.current) return;
    setNeedsReconnect(false);
    setRailRequestAt(undefined);
    setActiveStep(step);
  }, [activeStep, connectPhysical]);

  const runApproval = useCallback(async (request: BenchApprovalRequest): Promise<void> => {
    const gate = approvalGate(request.action, {
      connected: runner !== undefined,
      safeReady: activeStep >= 2,
      railsReady: Boolean(runner?.state.seenHello && runner.state.seenVcc),
      passed: run?.verdict === "pass",
      loadedRevision: loaded?.revision.n ?? -1,
      requestRevision: request.revision,
    });
    if (!gate.ok) {
      setError(gate.reason);
      return;
    }
    setBusy(`approval:${request.id}`);
    try {
      const started = await readJson<{ id: string; action: BenchApprovalRequest["action"]; revision: number }>(`/api/missions/${encodeURIComponent(missionId)}/bench/requests/${encodeURIComponent(request.id)}/start`, { method: "POST" });
      setRequests((current) => current.filter((candidate) => candidate.id !== request.id));
      if (started.action === "flash-bench") await flashSafe();
      else if (started.action === "rail-checkpoint") {
        setActiveStep(2);
        await startRail();
      } else if (started.action === "run-selftest") {
        setActiveStep(3);
        await startSelfTest();
      } else {
        await flashApp();
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [activeStep, flashApp, flashSafe, loaded, missionId, run, runner, startRail, startSelfTest]);

  const denyApproval = useCallback(async (request: BenchApprovalRequest): Promise<void> => {
    setBusy(`deny:${request.id}`);
    try {
      await readJson<unknown>(`/api/missions/${encodeURIComponent(missionId)}/bench/requests/${encodeURIComponent(request.id)}/deny`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setRequests((current) => current.filter((candidate) => candidate.id !== request.id));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [missionId]);

  // Answering is separate from `busy`: a checkpoint run stays busy until its last test ends, and its prompts must
  // stay answerable meanwhile (clearing `busy` after an answer would also re-enable the earlier steps' buttons).
  const [answering, setAnswering] = useState<string>();
  const answerAsk = useCallback(async (askId: string, value: string): Promise<void> => {
    if (!runner) return;
    setAnswering(askId);
    try {
      await runner.answer(askId, value);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAnswering(undefined);
    }
  }, [runner]);

  const resetForFault = useCallback((): void => {
    if (mode !== "virtual" || !loaded || !benchHex || !virtualRef.current) return;
    try {
      const simulatedCircuit = circuitWithFault(loaded.revision.circuit, fault, loaded.layout);
      const nextRunner = attachRunner(virtualRef.current, loaded.plan, simulatedCircuit, loaded.revision.n);
      virtualRef.current.start({ circuit: simulatedCircuit, hex: benchHex, fault });
      setRunner(nextRunner);
      setRunnerState(nextRunner.state);
      setRun(undefined);
      setError(undefined);
      setFlashProgress(undefined);
      setActiveStep(1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [attachRunner, benchHex, fault, loaded, mode]);

  const restartSelfTest = useCallback((): void => {
    if (!loaded) return;
    try {
      let nextRunner: BenchRunner;
      if (mode === "virtual") {
        if (!benchHex || !virtualRef.current) throw new Error("Reconnect the virtual board before restarting the self-test.");
        const simulatedCircuit = circuitWithFault(loaded.revision.circuit, fault, loaded.layout);
        nextRunner = attachRunner(virtualRef.current, loaded.plan, simulatedCircuit, loaded.revision.n);
        virtualRef.current.start({ circuit: simulatedCircuit, hex: benchHex, fault });
      } else {
        const selected = connectionRef.current;
        if (!selected) throw new Error("Reconnect the board before restarting the self-test.");
        nextRunner = attachRunner(selected.transport, loaded.plan, loaded.revision.circuit, loaded.revision.n);
      }
      setRunner(nextRunner);
      setRunnerState(nextRunner.state);
      setRun(undefined);
      setSelectedCandidate(0);
      telemetry.set(undefined);
      setHighlight({ holes: [], parts: [], jumpers: [] });
      setError(undefined);
      setRailRequestAt(undefined);
      setActiveStep(2);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [attachRunner, benchHex, fault, loaded, mode]);

  const availableFaults = useMemo(
    () => {
      if (!loaded) return [];
      return FAULTS.filter((definition) => {
        try {
          return applyBrowserFault(loaded.revision.circuit, definition.id, loaded.layout) !== undefined;
        } catch {
          return false;
        }
      });
    },
    [loaded],
  );
  if (authRequired) return null;
  if (!loaded) {
    return (
      <Box>
        {loadError ? <Alert severity="error">{loadError}</Alert> : <Stack sx={{ mt: 6, alignItems: "center" }}><CircularProgress /><Typography sx={{ mt: 2 }}>Loading the released revision…</Typography></Stack>}
      </Box>
    );
  }

  const railReady = Boolean(runnerState?.seenHello && runnerState.seenVcc);
  const pendingAsks = (runnerState?.asks ?? []).filter((ask) => runnerState?.answers[ask.id] === undefined);
  const showPromptColumn = pendingAsks.length > 0 || remoteAnswer !== undefined || Boolean(runnerState?.done);
  const topCandidate = run?.verdict === "pass" ? undefined : run?.diagnosis.candidates[selectedCandidate];
  const indistinguishable = run !== undefined && /indistinguishable|equally likely|cannot distinguish/i.test(run.diagnosis.summary);
  const allLines = runnerState?.rawLines ?? [];
  const displayLines = cleanTelemetryLog(allLines);
  const currentProfile = connection?.profile;
  const benchArtifactUrl = loaded.revision.artifactUrls["bench.hex"];
  const appArtifactUrl = loaded.revision.artifactUrls["app.hex"];
  const lastRun = loaded.revision.results.bench?.at(-1);
  const timedOutAsk = run?.verdict === "incomplete" ? runnerState?.lines.find((line): line is Extract<DeviceLine, { t: "ask" }> => line.t === "ask" && runnerState?.answers[line.id] === "timeout") : undefined;
  const timedOutPrompt = timedOutAsk ? promptTitle(timedOutAsk, loaded.plan, promptFor(timedOutAsk, loaded.plan).title) : "a self-test prompt";
  const fix = mode === "physical" ? errorFix : undefined;
  const retryLabel = fix === "reconnect" ? "Choose the port again" : fix === "flash" ? "Flash again" : activeStep === 1 ? "Retry flash" : activeStep === 2 ? "Retry power check" : activeStep === 3 ? "Restart self-test" : activeStep >= 4 ? "Retry app firmware" : "Retry";
  const retryCurrentStep = (): void => {
    setError(undefined);
    setTechnicalError(undefined);
    setErrorFix(undefined);
    if (fix === "reconnect") {
      runnerRef.current?.dispose();
      runnerRef.current = undefined;
      void connectionRef.current?.transport.close().catch(() => undefined);
      connectionRef.current = undefined;
      setConnection(undefined);
      setFlashProgress(undefined);
      setActiveStep(0);
      void connectPhysical();
    } else if (fix === "flash") {
      setActiveStep(1);
      void flashSafe();
    } else if (activeStep === 1) void flashSafe();
    else if (activeStep === 2) void startRail();
    else if (activeStep === 3) restartSelfTest();
    else if (activeStep >= 4) void flashApp();
  };
  // After Connect, the board's own banner tells whether a flash is needed at all.
  const connectHello = mode === "physical" && activeStep === 1 ? runnerState?.seenHello : undefined;
  const alreadyFlashed = connectHello !== undefined && connectHello.design === loaded.plan.design && connectHello.board === loaded.plan.board;

  return (
    // A size container: the bench sits in the resizable mission panel, so its rows follow the panel's width, not the window's.
    <Box sx={{ containerType: "inline-size", color: "text.primary" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ flex: "1 1 220px" }}>
          <Typography variant="h6" component="h2">Bench</Typography>
          <Typography variant="body2" color="text.secondary">Flash and self-test design r{loaded.revision.n} on your board, or practise on the virtual board.</Typography>
        </Box>
        <Chip label={mode === "virtual" ? "Virtual board" : currentProfile?.name ?? "No board"} color={mode === "virtual" ? "info" : currentProfile ? "success" : "default"} />
      </Stack>
      {subsetTests.length > 0 && <Alert severity="info" action={benchQuery.returnTo ? <Button component={Link} to={benchQuery.returnTo} color="inherit" size="small">Back to step</Button> : undefined}>Checking this subsection: {subsetTests.map(testLabel).join(", ")}.</Alert>}

      {/* Seven labels need room: under 640 px of panel only the current step keeps its label. */}
      <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 3, "@container (max-width: 640px)": { "& .MuiStep-root:not(.Mui-active) .MuiStepLabel-label": { display: "none" } } }}>
        {STEPS.map((label, index) => <Step key={label} className={index === activeStep ? "Mui-active" : undefined}><StepLabel>{label}</StepLabel></Step>)}
      </Stepper>

      <Stack spacing={2.5}>
        <Card>
          <CardContent>
            <Stack spacing={2} useFlexGap sx={{ justifyContent: "space-between", flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row", alignItems: "center" } }}>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>Choose your bench</Typography>
                <Typography color="text.secondary" sx={{ mt: 0.5 }}>Physical actions stay behind an explicit click in this page. "Try without a board" runs the same self-test on a simulated Arduino, so you can practise before plugging anything in.</Typography>
              </Box>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexShrink: 0, flexWrap: "wrap" }}>
                <Button variant={mode === "virtual" ? "contained" : "outlined"} onClick={() => setMode("virtual")} sx={{ ...actionButtonSx, whiteSpace: "nowrap" }}>Try without a board</Button>
                <Button variant={mode === "physical" ? "contained" : "outlined"} onClick={() => setMode("physical")} sx={{ ...actionButtonSx, whiteSpace: "nowrap" }}>Use USB board</Button>
              </Stack>
            </Stack>
            {lastRun && <Alert severity={lastRun.verdict === "pass" ? "success" : "warning"} sx={{ mt: 2 }}>Last self-test: {lastRun.verdict.toUpperCase()} · {lastRun.diagnosis.summary}</Alert>}
            {mode === "virtual" && (
              <Stack spacing={2} useFlexGap sx={{ mt: 2, flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row", alignItems: "flex-end" } }}>
                <FormControl size="small" sx={{ minWidth: "min(290px, 100%)" }}>
                  <InputLabel id="virtual-fault-label">Inject a wiring fault</InputLabel>
                  <Select labelId="virtual-fault-label" value={fault} label="Inject a wiring fault" onChange={(event) => setFault(event.target.value as VirtualFault)}>
                    <MenuItem value="none">{faultLabel("none")}</MenuItem>
                    {availableFaults.map((definition) => <MenuItem key={definition.id} value={definition.id}>{definition.title}</MenuItem>)}
                  </Select>
                </FormControl>
                {virtualRef.current && <Button variant="outlined" onClick={resetForFault} sx={actionButtonSx}>Apply fault and restart</Button>}
              </Stack>
            )}
            {mode === "physical" && (
              <Paper variant="outlined" sx={{ mt: 2, p: 2 }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
                  <Box aria-hidden sx={{ width: 104, height: 64, border: "2px solid", borderColor: "primary.main", borderRadius: 2, p: 1, position: "relative" }}>
                    <Typography sx={{ fontFamily: MONO_FONT, fontSize: 12, textAlign: "center" }}>USB ↔ Arduino</Typography>
                    <Box sx={{ position: "absolute", bottom: 6, left: 12, right: 12, height: 6, borderRadius: 3, bgcolor: "success.main" }} />
                  </Box>
                  <Box>
                    <Typography sx={{ fontWeight: 700 }}>Picture-like hint: choose the port with the board plugged in</Typography>
                    <Typography color="text.secondary" variant="body2">Look for Arduino Uno/Nano or a CH340 / FTDI / CP2102 bridge. ViBread filters the chooser to these USB IDs; never choose a keyboard, mouse, or charge-only cable.</Typography>
                  </Box>
                </Stack>
                <FormControl size="small" sx={{ mt: 2, minWidth: "min(290px, 100%)" }}>
                  <InputLabel id="board-profile-label">Bootloader profile</InputLabel>
                  <Select labelId="board-profile-label" value={boardProfileChoice} label="Bootloader profile" onChange={(event) => setBoardProfileChoice(event.target.value as BoardProfileId | "auto")}>
                    <MenuItem value="auto">Auto-detect from USB ID</MenuItem>
                    <MenuItem value="uno-r3-atmega328p-5v">Uno R3 · 115200</MenuItem>
                    <MenuItem value="nano-atmega328p-5v">Nano new bootloader · 115200</MenuItem>
                    <MenuItem value="nano-atmega328p-old-5v">Nano old bootloader · 57600</MenuItem>
                  </Select>
                </FormControl>
              </Paper>
            )}
            <Button variant="contained" onClick={() => void connect()} disabled={Boolean(busy) || activeStep > 0} sx={{ ...actionButtonSx, mt: 2 }}>{busy === "connect" ? "Opening…" : mode === "virtual" ? "Start virtual board" : "Choose filtered USB port"}</Button>
            {mode === "physical" && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Supported browser: Chrome or Edge. On unsupported browsers, use the laptop fallback below.</Typography>}
          </CardContent>
        </Card>

        {error && <Alert severity="error" onClose={() => { setError(undefined); setTechnicalError(undefined); setNativeFailed(undefined); }} action={nativeFailed?.message === error ? <Button color="inherit" size="small" onClick={() => void flashNativeFirmware(nativeFailed.which)} disabled={Boolean(busy) || !native.port}>Retry with avrdude</Button> : <Button color="inherit" size="small" onClick={retryCurrentStep}>{retryLabel}</Button>}>{error}{technicalError && <Box component="details" sx={{ mt: 1 }}><Box component="summary" sx={{ cursor: "pointer" }}>Technical details</Box><Box component="code" sx={{ display: "block", mt: 1, fontFamily: MONO_FONT, whiteSpace: "pre-wrap" }}>{technicalError}</Box></Box>}</Alert>}
        {needsReconnect && mode === "physical" && (
          <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => void reconnectAfterNativeFlash()} disabled={Boolean(busy)}>Reconnect to run the checks</Button>}>
            Flashed ✓ (avrdude). The browser didn't get the board's port back by itself: reconnect it to run the checks.
          </Alert>
        )}
        {requests.map((request) => {
          const gate = approvalGate(request.action, { connected: runner !== undefined, safeReady: activeStep >= 2, railsReady: Boolean(runner?.state.seenHello && runner.state.seenVcc), passed: run?.verdict === "pass", loadedRevision: loaded.revision.n, requestRevision: request.revision });
          return <Card key={request.id} variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Claude Code asked: {request.summary} (r{request.revision})</Typography>
              {request.note && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{request.note}</Typography>}
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1, alignItems: { sm: "center" } }}>
                <Chip label={request.preApprovedBy?.channel === "imessage" ? `Pre-approved from iMessage by ${request.preApprovedBy.name ?? "your helper"}` : "Needs your OK"} color={request.preApprovedBy?.channel === "imessage" ? "success" : "default"} size="small" />
                <Button variant="contained" size="small" disabled={!gate.ok || Boolean(busy)} title={gate.ok ? undefined : gate.reason} onClick={() => void runApproval(request)}>Run it now</Button>
                <Button variant="outlined" size="small" disabled={Boolean(busy)} onClick={() => void denyApproval(request)}>Decline</Button>
                {!gate.ok && <Typography variant="caption" color="text.secondary">{gate.reason}</Typography>}
              </Stack>
            </CardContent>
          </Card>;
        })}

        {activeStep >= 1 && (
          <Card>
            <CardContent>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 2 · Make it safe</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>ViBread puts every pin in a safe listening mode before it tests your parts. This check belongs to design <strong>{loaded.revision.hash.slice(0, 12)}</strong>.</Typography>
              {currentProfile && connection && <Chip label={describePort(connection)} size="small" sx={{ mt: 1 }} />}
              {mode === "physical" && native.ports && (
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} useFlexGap sx={{ mt: 2, alignItems: { sm: "center" } }}>
                  <FormControl size="small" sx={{ minWidth: "min(300px, 100%)" }}>
                    <InputLabel id="native-port-label">Board port (ViBread's uploader)</InputLabel>
                    <Select labelId="native-port-label" label="Board port (ViBread's uploader)" value={native.port ?? ""} onChange={(event) => native.setPort(String(event.target.value))}>
                      {native.ports.map((candidate) => <MenuItem key={candidate.port} value={candidate.port}>{candidate.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Button variant="text" size="small" onClick={() => void native.refresh()} disabled={native.refreshing || Boolean(busy)}>{native.refreshing ? "Looking…" : "Refresh ports"}</Button>
                  {native.ports.length === 0 && <Typography variant="body2" color="text.secondary">No Arduino port found on this computer yet. Plug the board in and refresh.</Typography>}
                </Stack>
              )}
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} useFlexGap sx={{ mt: 2, alignItems: { sm: "center" }, flexWrap: "wrap" }}>
                {mode === "physical" && native.ports && <Button variant="contained" onClick={() => void flashNativeFirmware("bench")} disabled={Boolean(busy) || activeStep !== 1 || !native.port} sx={actionButtonSx}>{busy === "native:bench" ? "Flashing with avrdude…" : "Flash with ViBread's uploader (avrdude)"}</Button>}
                <Button variant={mode === "physical" && native.ports ? "outlined" : "contained"} onClick={() => void flashSafe()} disabled={Boolean(busy) || activeStep !== 1} sx={actionButtonSx}>{mode === "virtual" ? "Skip flash · load virtual HEX" : native.ports ? "Flash in the browser (Web Serial)" : "Flash safe firmware"}</Button>
                {busy?.startsWith("native:") && <Box sx={{ minWidth: 230 }}><Typography variant="body2" color="text.secondary">Uploading to {native.port} with avrdude…</Typography><LinearProgress /></Box>}
                {flashProgress && !busy?.startsWith("native:") && <Box sx={{ minWidth: 230 }}><Typography variant="body2" color="text.secondary">{progressText(flashProgress)}</Typography><LinearProgress variant="determinate" value={flashProgress.percent} /></Box>}
              </Stack>
              {nativeOutput && <Box component="details" sx={{ mt: 1 }}><Box component="summary" sx={{ cursor: "pointer", color: "text.secondary", typography: "body2" }}>Uploader output</Box><Box component="code" sx={{ display: "block", mt: 1, fontFamily: MONO_FONT, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}>{nativeOutput}</Box></Box>}
              {alreadyFlashed && connectHello && (
                <Alert severity="success" sx={{ mt: 2 }} action={<Button color="inherit" size="small" onClick={skipFlash} disabled={Boolean(busy)}>Skip to power check</Button>}>
                  This board already runs the safe firmware for this design (design {connectHello.design.slice(0, 12)}, {Object.values(BOARD_PROFILES).find((profile) => profile.id === connectHello.board)?.name ?? connectHello.board}). You can skip the flash.
                </Alert>
              )}
              {connectHello && !alreadyFlashed && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  This board runs ViBread firmware for another design ({connectHello.design.slice(0, 12)}). Flashing replaces it with this design's safe firmware.
                </Alert>
              )}
              {mode === "physical" && <Alert severity="warning" sx={{ mt: 2 }}>Keep the board bare for this step. ViBread verifies the ATmega328P signature <code>1E 95 0F</code> before writing.</Alert>}
            </CardContent>
          </Card>
        )}

        {activeStep >= 2 && (
          <Card>
            <CardContent>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 3 · Check board power</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>This confirms the Arduino board is powered (VCC ≈ 5 V). The breadboard rails get tested by the part checks that follow.</Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
                <Chip label={runnerState?.seenHello ? `Banner: ${runnerState.seenHello.design}` : "Waiting for hello banner"} color={runnerState?.seenHello ? "success" : "default"} />
                <Chip label={runnerState?.seenVcc ? `VCC ${runnerState.seenVcc.mv} mV` : "Waiting for VCC"} color={runnerState?.seenVcc ? "success" : "default"} />
              </Stack>
              <Button variant="contained" onClick={() => void startRail()} disabled={Boolean(busy) || activeStep !== 2} sx={{ ...actionButtonSx, mt: 2 }}>{busy === "rail" ? "Checking…" : "Check board power"}</Button>
              {railReady && <Button variant="outlined" onClick={() => void startSelfTest()} disabled={Boolean(busy) || activeStep !== 2} sx={{ ...actionButtonSx, mt: 2, ml: 1 }}>Board powered · begin self-test</Button>}
            </CardContent>
          </Card>
        )}

        {activeStep >= 3 && (
          <Card>
            <CardContent>
              <Stack spacing={2} useFlexGap sx={{ justifyContent: "space-between", flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row" } }}>
                <Box>
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 4 · Test each part</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>We look first, then gently test each button, sensor, buzzer, and light.</Typography>
                </Box>
                <Chip label={`${runnerState?.lines.length ?? 0} telemetry lines`} color="info" variant="outlined" />
              </Stack>
              {/* The prompt sits beside the board only while there is one; otherwise the board gets the full width. */}
              <Stack spacing={2} useFlexGap sx={{ mt: 2, flexDirection: "column", "@container (min-width: 900px)": { flexDirection: "row", alignItems: "flex-start" } }}>
                {showPromptColumn && <Box sx={{ flex: 1, minWidth: 0, width: "100%" }}>
                  {pendingAsks.length > 0 && (
                    <Stack spacing={2}>
                      {pendingAsks.map((ask) => {
                        const prompt = promptFor(ask, loaded.plan);
                        const hint = mode === "virtual" ? virtualPromptHint(ask) : undefined;
                        return <Paper key={ask.id} sx={{ p: 2.5, border: "2px solid", borderColor: "secondary.main", bgcolor: "background.paper" }}>
                          <Typography variant="h6" sx={{ fontWeight: 700 }}>{promptTitle(ask, loaded.plan, prompt.title)}</Typography>
                          <Typography color="text.secondary" sx={{ mb: 2 }}>{ask.kind === "which-led" ? "Watch the labeled lights on the virtual board and choose which one blinked." : hint ? `${hint} Tap Done to continue.` : prompt.body}</Typography>
                          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
                            {prompt.choices.map((choice) => <Button key={choice.value} variant="contained" onClick={() => void answerAsk(ask.id, choice.value)} disabled={answering !== undefined || (busy !== undefined && busy !== "selftest")} sx={actionButtonSx}>{choice.label}</Button>)}
                          </Stack>
                        </Paper>;
                      })}
                    </Stack>
                  )}
                  {remoteAnswer && <Alert severity="info" sx={{ mt: 2 }}>Answered from iMessage by {remoteAnswer.by}: {remoteAnswer.value}</Alert>}
                  {runnerState?.done && <Alert severity="info" sx={{ mt: 2 }}>All device tests finished. Preparing the Houston diagnosis…</Alert>}
                </Box>}
                {mode === "virtual" && (
                  <Paper variant="outlined" sx={{ flex: 1, minWidth: 0, width: "100%", p: 1.5 }}>
                    <Typography variant="subtitle2">Virtual board — watch the lights here</Typography>
                    <DecoratedBoard svg={loaded.boardSvg} highlight={highlight} telemetry={telemetry} sx={{ mt: 1, p: 1, bgcolor: "canvas.main", borderRadius: 1, border: 1, borderColor: "divider", "& svg": { display: "block", width: "100%", height: "auto", "& .vb-hl": { stroke: "#ff6b6b", strokeWidth: 3 } } }} />
                  </Paper>
                )}
              </Stack>
              <Divider sx={{ my: 2 }} />
              <SerialMonitor value={displayLines.join("\n")} title="Live line log" ariaLabel="Telemetry line log" emptyText="Waiting for NDJSON…" height="auto" maxHeight={220} />
            </CardContent>
          </Card>
        )}

        {activeStep >= 4 && run && (
          <Card>
            <CardContent>
              <Stack spacing={2} useFlexGap sx={{ justifyContent: "space-between", flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row", alignItems: "center" } }}>
                <Box>
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 5 · Find the problem</Typography>
                  <Typography variant="h6" sx={{ mt: 1, color: run.verdict === "pass" ? "success.main" : "warning.main" }}>{run.verdict === "pass" ? "Houston, we are GO." : run.diagnosis.summary}</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>Attribution: {run.diagnosis.attribution}. Candidates are ranked from the telemetry and the revision netlist.</Typography>
                </Box>
                <Chip label={run.verdict.toUpperCase()} color={run.verdict === "pass" ? "success" : "warning"} />
              </Stack>
              <Stack spacing={2} useFlexGap sx={{ mt: 2, flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row" } }}>
                <Box sx={{ flex: 1 }}>
                  {run.verdict === "pass" ? <Alert severity="success">No wiring fault found. The self-test agrees with the released design.</Alert> : run.verdict === "incomplete" ? <Alert severity="warning">We did not get an answer for {timedOutPrompt}. Nothing was blamed on your wiring. <Button color="inherit" size="small" onClick={restartSelfTest}>Run the self-test again</Button></Alert> : run.diagnosis.candidates.length === 0 ? <Alert severity="warning">No single wiring cause was identified. Check the highlighted area, then rerun the self-test.</Alert> : <Stack spacing={1}>{run.diagnosis.candidates.map((candidate, index) => <Button key={candidate.cause} variant={selectedCandidate === index ? "contained" : "outlined"} onClick={() => setSelectedCandidate(index)} sx={{ ...actionButtonSx, justifyContent: "space-between", textAlign: "left" }}><span>{index + 1}. {candidate.title}</span><span>{Math.round(candidate.likelihood * 100)}%</span></Button>)}</Stack>}
                  {run.verdict !== "pass" && run.verdict !== "incomplete" && (indistinguishable ? <Stack spacing={1} sx={{ mt: 2 }}>{run.diagnosis.candidates.slice(0, 2).map((candidate) => <Paper key={candidate.cause} variant="outlined" sx={{ p: 2 }}><Typography sx={{ fontWeight: 700 }}>{candidate.title}</Typography><Typography color="text.secondary">{candidate.fix}</Typography></Paper>)}</Stack> : topCandidate ? <Paper variant="outlined" sx={{ p: 2, mt: 2 }}><Typography sx={{ fontWeight: 700 }}>Recommended fix</Typography><Typography color="text.secondary">{topCandidate.fix}</Typography></Paper> : null)}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>Where to look on your board</Typography>
                  <DecoratedBoard svg={loaded.boardSvg} highlight={highlight} telemetry={telemetry} sx={{ "@keyframes vb-wire-pulse": { to: { strokeDashoffset: -32 } }, "& svg": { display: "block", width: "100%", height: "auto", bgcolor: "canvas.main", borderRadius: 1, border: 1, borderColor: "divider", "& .vb-hl": { stroke: "#ff6b6b", strokeWidth: 3, filter: "drop-shadow(0 0 5px rgba(255,107,107,.8))" }, "& .vb-hl path, & .vb-hl .wire-path": { stroke: "#ff6b6b !important", strokeWidth: 6, strokeDasharray: "14 8", animation: reducedMotion ? "none" : "vb-wire-pulse 1s linear infinite" } } }} />
                </Box>
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
                <Button variant="outlined" onClick={restartSelfTest} disabled={Boolean(busy)} sx={actionButtonSx}>{run.verdict === "pass" ? "Run the self-test again" : "Fix wiring and rerun"}</Button>
                {run.verdict === "pass" && mode === "physical" && native.ports && <Button variant="contained" onClick={() => void flashNativeFirmware("app")} disabled={Boolean(busy) || !native.port} sx={actionButtonSx}>{busy === "native:app" ? "Flashing with avrdude…" : "Flash app firmware with ViBread's uploader (avrdude)"}</Button>}
                {run.verdict === "pass" && <Button variant={mode === "physical" && native.ports ? "outlined" : "contained"} onClick={() => void flashApp()} disabled={Boolean(busy)} sx={actionButtonSx}>{mode === "virtual" ? "Continue to celebration" : native.ports ? "Flash app firmware in the browser (Web Serial)" : "Flash app firmware with calibration"}</Button>}
              </Stack>
            </CardContent>
          </Card>

        )}
        {activeStep >= 6 && (
          <Paper sx={{ p: { xs: 3, md: 6 }, textAlign: "center", overflow: "hidden", position: "relative", "@keyframes vb-liftoff": { from: { transform: "translateY(20px)", opacity: 0 }, to: { transform: "translateY(0)", opacity: 1 } }, animation: reducedMotion ? "none" : "vb-liftoff .8s ease-out" }}>
            <Typography variant="h2" sx={{ fontWeight: 900 }}>Mission verified</Typography>
            <Typography variant="h6" color="text.secondary" sx={{ mt: 1 }}>The bench telemetry agrees with the design. ViBread is GO for launch.</Typography>
            {mode === "virtual" && <><Typography variant="body2" sx={{ mt: 2 }}>Your project firmware is running on the virtual board.</Typography><DecoratedBoard svg={loaded.boardSvg} highlight={highlight} telemetry={telemetry} sx={{ maxWidth: 720, mx: "auto", mt: 2, "& svg": { display: "block", width: "100%", height: "auto" } }} /></>}
          </Paper>
        )}

        {mode === "physical" && (
          <Alert severity="info" icon={false}>
            <Typography sx={{ fontWeight: 700 }}>Laptop fallback</Typography>
            <Typography variant="body2">If this browser cannot use Web Serial, release the port and upload either server-built HEX on the laptop:</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
              {benchArtifactUrl ? <Button component="a" href={benchArtifactUrl} download="bench.hex" variant="outlined" sx={actionButtonSx}>Download bench.hex</Button> : <Button onClick={() => void downloadFirmware("bench")} disabled={Boolean(busy)} variant="outlined" sx={actionButtonSx}>Download bench.hex</Button>}
              {appArtifactUrl ? <Button component="a" href={appArtifactUrl} download="app.hex" variant="outlined" sx={actionButtonSx}>Download app.hex</Button> : <Button onClick={() => void downloadFirmware("app")} disabled={Boolean(busy)} variant="outlined" sx={actionButtonSx}>Download app.hex</Button>}
            </Stack>
            {fallbackUpload && <Stack spacing={1} useFlexGap sx={{ mt: 1, flexDirection: "column", [WIDE_PANEL]: { flexDirection: "row", alignItems: "center" } }}>
              <Box component="code" sx={{ display: "block", flex: 1, fontFamily: MONO_FONT, overflowX: "auto" }}>{fallbackCommand(fallbackUpload)}</Box>
              <Button variant="outlined" size="small" onClick={() => void navigator.clipboard?.writeText(fallbackCommand(fallbackUpload))}>Copy command</Button>
            </Stack>}
            <Typography variant="body2" sx={{ mt: 1 }}>After flashing, connect the board here again to run the self-test.</Typography>
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
