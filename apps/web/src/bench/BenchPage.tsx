import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import type { BenchRunResult, BoardProfileId, Circuit, DeviceLine, Layout, MissionDetail, RevisionDetail, SelfTestPlan } from "@vibread/core";
import { BOARD_PROFILES, revisionHash } from "@vibread/core";
import { FAULTS, evaluateRun, planSelfTest, promptFor } from "@vibread/bench";
import { BenchRunner, type BenchRunnerState } from "./runner.js";
import { applyBrowserFault, circuitWithFault } from "./faults.js";
import { decorateBreadboardSvg, fallbackBreadboardSvg, candidateHighlight, type SvgHighlight } from "./svg.js";
import {
  describePort,
  flashHex,
  requestBoardPort,
  UnsupportedWebSerialError,
  type BoardPortConnection,
  type FlashProgress,
} from "./serial.js";
import { faultLabel, VirtualBenchTransport, type VirtualFault, type VirtualPartTelemetry } from "./virtual.js";
import { BenchAskBridge, type RemoteAskStatus } from "./askBridge.js";
import { approvalGate } from "./approval.js";

const STEPS = ["Connect your board", "Make it safe", "Check power", "Test each part", "Find the problem", "Run your project", "Celebrate"];
const BOARD_LOST_POWER = "Board lost power — unplug, then check the rails and the cable";

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
  const artifactUrl = revision.artifactUrls["breadboard.svg"] ?? revision.artifactUrls["breadboard"];
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

function isLostPowerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|serial|power|banner|timeout|port/i.test(message);
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
  if (ask.kind === "which-led" && subject?.kind === "led") {
    const total = plan.subjects.filter((candidate) => candidate.kind === "led").length;
    return `Light ${subject.order} of ${total}: ${fallback}`;
  }
  return subject === undefined ? fallback : `${subject.label}: ${fallback}`;
}

const actionButtonSx = { minHeight: 46, borderRadius: 2 } as const;

export default function BenchPage(): ReactElement | null {
  const { missionId = "" } = useParams<{ missionId: string }>();
  const [logPinned, setLogPinned] = useState(true);
  const [loaded, setLoaded] = useState<LoadedBench | undefined>();
  const [loadError, setLoadError] = useState<string>();
  const [authRequired, setAuthRequired] = useState(false);
  const [mode, setMode] = useState<"physical" | "virtual">("virtual");
  const [boardProfileChoice, setBoardProfileChoice] = useState<BoardProfileId | "auto">("auto");
  const logRef = useRef<HTMLPreElement | null>(null);
  const [fault, setFault] = useState<VirtualFault>("none");
  const [activeStep, setActiveStep] = useState(0);
  const [connection, setConnection] = useState<BoardPortConnection | undefined>();
  const [runnerState, setRunnerState] = useState<BenchRunnerState>();
  const [runner, setRunner] = useState<BenchRunner>();
  const [benchHex, setBenchHex] = useState<string>();
  const [fallbackUpload, setFallbackUpload] = useState<{ command: string; args: string[] }>();
  const [flashProgress, setFlashProgress] = useState<FlashProgress>();
  const [telemetry, setTelemetry] = useState<VirtualPartTelemetry>();
  const [run, setRun] = useState<BenchRunResult>();
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [highlight, setHighlight] = useState<SvgHighlight>({ holes: [], parts: [], jumpers: [] });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [remoteAnswer, setRemoteAnswer] = useState<{ id: string; value: string; by: string }>();
  const [requests, setRequests] = useState<BenchApprovalRequest[]>([]);
  const askBridgeRef = useRef<Map<string, BenchAskBridge>>(new Map());
  const [reducedMotion, setReducedMotion] = useState(false);
  const virtualRef = useRef<VirtualBenchTransport | undefined>(undefined);
  const connectionRef = useRef<BoardPortConnection | undefined>(undefined);
  const runnerRef = useRef<BenchRunner | undefined>(undefined);
  const railRequestAt = useRef<number | undefined>(undefined);
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
        if (alive) setLoaded(value);
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
    if (!logPinned || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logPinned, runnerState?.rawLines.length]);
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
    if (activeStep !== 2 || !railRequestAt.current) return undefined;
    const timer = window.setTimeout(() => {
      const current = runnerRef.current?.state;
      if (!current?.seenHello || !current.seenVcc) {
        current && runnerRef.current?.fail(BOARD_LOST_POWER);
        setError(BOARD_LOST_POWER);
      }
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [activeStep]);

  useEffect(() => {
    const candidate = run?.diagnosis.candidates[selectedCandidate];
    setHighlight(candidateHighlight(candidate));
  }, [run, selectedCandidate]);

  const decoratedSvg = useMemo(() => {
    if (!loaded) return "";
    return decorateBreadboardSvg(loaded.boardSvg, highlight, telemetry?.parts);
  }, [loaded, highlight, telemetry]);

  const attachRunner = useCallback((nextTransport: BoardPortConnection["transport"] | VirtualBenchTransport, plan: SelfTestPlan, circuit: Circuit, revision: number): BenchRunner => {
    runnerRef.current?.dispose();
    const nextRunner = new BenchRunner({
      plan,
      circuit,
      revision,
      runId: nextTransport instanceof VirtualBenchTransport ? `virtual-${Date.now().toString(36)}` : undefined,
      transport: nextTransport,
      onState: (next) => {
        setRunnerState({ ...next });
        if (next.error) setError(isLostPowerError(next.error) ? BOARD_LOST_POWER : next.error);
      },
    });
    runnerRef.current = nextRunner;
    setRunner(nextRunner);
    setRunnerState(nextRunner.state);
    setLogPinned(true);
    return nextRunner;
  }, []);

  const connectPhysical = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId) return;
    setBusy("connect");
    setError(undefined);
    try {
      const picked = await requestBoardPort();
      const selected = boardProfileChoice === "auto" ? picked : { ...picked, profile: BOARD_PROFILES[boardProfileChoice] };
      connectionRef.current = selected;
      setConnection(selected);
      attachRunner(selected.transport, loaded.plan, loaded.revision.circuit, loaded.revision.n);
      setActiveStep(1);
    } catch (reason: unknown) {
      if (reason instanceof UnsupportedWebSerialError) setError("Web Serial is unavailable. Use Chrome or Edge on the laptop; Firefox is not supported here.");
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [attachRunner, boardProfileChoice, loaded, missionId]);

  const connectVirtual = useCallback(async (): Promise<void> => {
    if (!loaded || !missionId) return;
    setBusy("connect");
    setError(undefined);
    try {
      const firmware = await firmwareFor(missionId, "bench");
      setBenchHex(firmware.hex);
      setFallbackUpload(firmware.fallbackUpload);
      const virtual = new VirtualBenchTransport({
        onTelemetry: setTelemetry,
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
    setFlashProgress(undefined);
    try {
      const firmware = benchHex ? { hex: benchHex, fallbackUpload } : await firmwareFor(missionId, "bench");
      setBenchHex(firmware.hex);
      setFallbackUpload(firmware.fallbackUpload);
      if (mode === "physical") {
        const selected = connectionRef.current;
        if (!selected) throw new Error("Connect the board before flashing safe firmware.");
        await flashHex({ connection: selected, hex: firmware.hex, onProgress: setFlashProgress });
      }
      setFlashProgress({ stage: mode === "virtual" ? "Virtual flash skipped" : "verified", percent: 100 });
      setActiveStep(2);
    } catch (reason: unknown) {
      const message = isLostPowerError(reason) ? BOARD_LOST_POWER : reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }, [benchHex, connection, fallbackUpload, loaded, missionId, mode, runner]);

  const startRail = useCallback(async (): Promise<void> => {
    if (!runner) return;
    setBusy("rail");
    setError(undefined);
    railRequestAt.current = Date.now();
    try {
      await runner.startRail();
    } catch (reason: unknown) {
      runner.fail(BOARD_LOST_POWER);
      setError(BOARD_LOST_POWER);
    } finally {
      setBusy(undefined);
    }
  }, [runner]);

  const startSelfTest = useCallback(async (): Promise<void> => {
    if (!runner || !runnerState?.seenHello || !runnerState.seenVcc) return;
    setBusy("selftest");
    setError(undefined);
    setRun(undefined);
    setSelectedCandidate(0);
    try {
      setActiveStep(3);
      await runner.startSelfTest();
    } catch (reason: unknown) {
      const message = isLostPowerError(reason) ? BOARD_LOST_POWER : reason instanceof Error ? reason.message : String(reason);
      runner.fail(message);
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }, [runner, runnerState]);

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
          body: JSON.stringify({ ...request, runId: runner.runId }),
        });
      } catch (serverReason: unknown) {
        if (mode !== "virtual") throw serverReason;
        result = await evaluateRun({
          circuit: loaded.revision.circuit,
          plan: loaded.plan,
          lines: request.lines,
          answers: request.answers,
          kind: request.kind,
          revision: request.revision,
          runId: runner.runId,
        });
      }
      setRun(result);
      setSelectedCandidate(0);
      setActiveStep(4);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  }, [loaded, missionId, mode, runner]);

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
        await flashHex({ connection: selected, hex: firmware.hex, onProgress: setFlashProgress });
        setFlashProgress({ stage: "verified", percent: 100 });
      } else {
        if (!virtualRef.current) throw new Error("Connect the virtual board before running app firmware.");
        runnerRef.current?.dispose();
        virtualRef.current.start({ circuit: loaded.revision.circuit, hex: firmware.hex, fault: "none" });
        setRunner(undefined);
        setRunnerState(undefined);
        setTelemetry(undefined);
        setFlashProgress({ stage: "Virtual app firmware running", percent: 100 });
      }
      setActiveStep(6);
    } catch (reason: unknown) {
      const message = isLostPowerError(reason) ? BOARD_LOST_POWER : reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }, [loaded, missionId, mode]);

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

  const answerAsk = useCallback(async (askId: string, value: string): Promise<void> => {
    if (!runner) return;
    setBusy(`answer:${askId}`);
    try {
      await runner.answer(askId, value);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
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
      setTelemetry(undefined);
      setHighlight({ holes: [], parts: [], jumpers: [] });
      setError(undefined);
      railRequestAt.current = undefined;
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
      <Box sx={{ minHeight: "100vh", p: { xs: 2, md: 5 } }}>
        <Button component={Link} to={`/m/${missionId}`} sx={actionButtonSx}>← Mission control</Button>
        {loadError ? <Alert severity="error" sx={{ mt: 3 }}>{loadError}</Alert> : <Stack sx={{ mt: 10, alignItems: "center" }}><CircularProgress /><Typography sx={{ mt: 2 }}>Loading the released revision…</Typography></Stack>}
      </Box>
    );
  }

  const railReady = Boolean(runnerState?.seenHello && runnerState.seenVcc);
  const pendingAsks = (runnerState?.asks ?? []).filter((ask) => runnerState?.answers[ask.id] === undefined);
  const topCandidate = run?.verdict === "pass" ? undefined : run?.diagnosis.candidates[selectedCandidate];
  const indistinguishable = run !== undefined && /indistinguishable|equally likely|cannot distinguish/i.test(run.diagnosis.summary);
  const allLines = runnerState?.rawLines ?? [];
  const currentProfile = connection?.profile;
  const benchArtifactUrl = loaded.revision.artifactUrls["bench.hex"];
  const appArtifactUrl = loaded.revision.artifactUrls["app.hex"];
  const lastRun = loaded.revision.results.bench?.at(-1);
  const timedOutAsk = run?.verdict === "incomplete" ? runnerState?.lines.find((line): line is Extract<DeviceLine, { t: "ask" }> => line.t === "ask" && runnerState?.answers[line.id] === "timeout") : undefined;
  const timedOutPrompt = timedOutAsk ? promptTitle(timedOutAsk, loaded.plan, promptFor(timedOutAsk, loaded.plan).title) : "a self-test prompt";

  return (
    <Box sx={{ minHeight: "100vh", p: { xs: 2, md: 4 }, background: "radial-gradient(circle at 80% 0%, rgba(57,91,148,.24), transparent 38%)" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3, alignItems: { sm: "center" }, justifyContent: "space-between" }}>
        <Box>
          <Button component={Link} to={`/m/${missionId}`} sx={{ ...actionButtonSx, mb: 1 }}>← Mission control</Button>
          <Typography variant="h3" sx={{ fontWeight: 800, letterSpacing: "-.03em" }}>Bench / Verify</Typography>
          <Typography color="text.secondary">Mission Control for your breadboard · {loaded.revision.circuit.title}</Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
          <Chip label={`Revision ${loaded.revision.n}`} color="primary" variant="outlined" />
          <Chip label={`Design ${loaded.revision.hash.slice(0, 10)}`} variant="outlined" />
          <Chip label={mode === "virtual" ? "Virtual board" : currentProfile?.name ?? "No board"} color={mode === "virtual" ? "info" : currentProfile ? "success" : "default"} />
        </Stack>
      </Stack>

      <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4 }}>
        {STEPS.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
      </Stepper>

      <Stack spacing={2.5}>
        <Card>
          <CardContent>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>Choose your bench</Typography>
                <Typography color="text.secondary" sx={{ mt: 0.5 }}>Physical actions stay behind an explicit click in this page. "Try without a board" runs the same self-test on a simulated Arduino, so you can practise before plugging anything in.</Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                <Button variant={mode === "virtual" ? "contained" : "outlined"} onClick={() => setMode("virtual")} sx={actionButtonSx}>Try without a board</Button>
                <Button variant={mode === "physical" ? "contained" : "outlined"} onClick={() => setMode("physical")} sx={actionButtonSx}>Use USB board</Button>
              </Stack>
            </Stack>
            {lastRun && <Alert severity={lastRun.verdict === "pass" ? "success" : "warning"} sx={{ mt: 2 }}>Last self-test: {lastRun.verdict.toUpperCase()} · {lastRun.diagnosis.summary}</Alert>}
            {mode === "virtual" && (
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2, alignItems: { md: "flex-end" } }}>
                <FormControl size="small" sx={{ minWidth: 290 }}>
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
              <Paper variant="outlined" sx={{ mt: 2, p: 2, background: "rgba(30,48,78,.35)" }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
                  <Box aria-hidden sx={{ width: 104, height: 64, border: "2px solid", borderColor: "primary.main", borderRadius: 2, p: 1, position: "relative" }}>
                    <Typography sx={{ fontFamily: "monospace", fontSize: 12, textAlign: "center" }}>USB ↔ Arduino</Typography>
                    <Box sx={{ position: "absolute", bottom: 6, left: 12, right: 12, height: 6, borderRadius: 3, bgcolor: "success.main" }} />
                  </Box>
                  <Box>
                    <Typography sx={{ fontWeight: 700 }}>Picture-like hint: choose the port with the board plugged in</Typography>
                    <Typography color="text.secondary" variant="body2">Look for Arduino Uno/Nano or a CH340 / FTDI / CP2102 bridge. ViBread filters the chooser to these USB IDs; never choose a keyboard, mouse, or charge-only cable.</Typography>
                  </Box>
                </Stack>
                <FormControl size="small" sx={{ mt: 2, minWidth: 290 }}>
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

        {error && <Alert severity="error" onClose={() => setError(undefined)} action={error === BOARD_LOST_POWER ? <Button color="inherit" size="small" onClick={() => { setError(undefined); void startRail(); }}>Retry rail checkpoint</Button> : undefined}>{error}</Alert>}
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
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 1 · Make it safe</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>ViBread puts every pin in a safe listening mode before it tests your parts. This check belongs to design <strong>{loaded.revision.hash.slice(0, 12)}</strong>.</Typography>
              {currentProfile && connection && <Chip label={describePort(connection)} size="small" sx={{ mt: 1 }} />}
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2, alignItems: { sm: "center" } }}>
                <Button variant="contained" onClick={() => void flashSafe()} disabled={Boolean(busy) || activeStep !== 1} sx={actionButtonSx}>{mode === "virtual" ? "Skip flash · load virtual HEX" : "Flash safe firmware"}</Button>
                {flashProgress && <Box sx={{ minWidth: 230 }}><Typography variant="body2" color="text.secondary">{progressText(flashProgress)}</Typography><LinearProgress variant="determinate" value={flashProgress.percent} /></Box>}
              </Stack>
              {mode === "physical" && <Alert severity="warning" sx={{ mt: 2 }}>Keep the board bare for this step. ViBread verifies the ATmega328P signature <code>1E 95 0F</code> before writing.</Alert>}
            </CardContent>
          </Card>
        )}

        {activeStep >= 2 && (
          <Card>
            <CardContent>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 2 · Check the power</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>The board should say hello and show a healthy power reading before anything is switched on.</Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
                <Chip label={runnerState?.seenHello ? `Banner: ${runnerState.seenHello.design}` : "Waiting for hello banner"} color={runnerState?.seenHello ? "success" : "default"} />
                <Chip label={runnerState?.seenVcc ? `VCC ${runnerState.seenVcc.mv} mV` : "Waiting for VCC"} color={runnerState?.seenVcc ? "success" : "default"} />
              </Stack>
              <Button variant="contained" onClick={() => void startRail()} disabled={Boolean(busy) || activeStep !== 2} sx={{ ...actionButtonSx, mt: 2 }}>{busy === "rail" ? "Listening…" : "Check rails and banner"}</Button>
              {railReady && <Button variant="outlined" onClick={() => void startSelfTest()} disabled={Boolean(busy) || activeStep !== 2} sx={{ ...actionButtonSx, mt: 2, ml: 1 }}>Rails good · begin self-test</Button>}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No banner, repeated resets, or a USB drop means the cable or rails need attention.</Typography>
            </CardContent>
          </Card>
        )}

        {activeStep >= 3 && (
          <Card>
            <CardContent>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
                <Box>
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 3 · Test each part</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>We look first, then gently test each button, sensor, buzzer, and light.</Typography>
                </Box>
                <Chip label={`${runnerState?.lines.length ?? 0} telemetry lines`} color="info" variant="outlined" />
              </Stack>
              {pendingAsks.length > 0 && (
                <Stack spacing={2} sx={{ mt: 2 }}>
                  {pendingAsks.map((ask) => {
                    const prompt = promptFor(ask, loaded.plan);
                    const hint = mode === "virtual" ? virtualPromptHint(ask) : undefined;
                    return <Paper key={ask.id} sx={{ p: 2.5, border: "2px solid", borderColor: "secondary.main", background: "rgba(101,78,163,.15)" }}>
                      <Typography variant="h6" sx={{ fontWeight: 700 }}>{promptTitle(ask, loaded.plan, prompt.title)}</Typography>
                      <Typography color="text.secondary" sx={{ mb: 2 }}>{hint ? `${hint} Tap Done to continue.` : prompt.body}</Typography>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
                        {prompt.choices.map((choice) => <Button key={choice.value} variant="contained" onClick={() => void answerAsk(ask.id, choice.value)} disabled={Boolean(busy)} sx={actionButtonSx}>{choice.label}</Button>)}
                      </Stack>
                    </Paper>;
                  })}
                </Stack>
              )}
              {mode === "virtual" && (
                <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
                  <Typography variant="subtitle2">Virtual board — watch the lights here</Typography>
                  <Box sx={{ mt: 1, maxHeight: 360, overflow: "auto", "& svg": { display: "block", width: "100%", height: "auto", "& .vb-hl": { stroke: "#ff6b6b", strokeWidth: 3 } } }} dangerouslySetInnerHTML={{ __html: decoratedSvg }} />
                </Paper>
              )}
              {remoteAnswer && <Alert severity="info" sx={{ mt: 2 }}>Answered from iMessage by {remoteAnswer.by}: {remoteAnswer.value}</Alert>}
              {runnerState?.done && <Alert severity="info" sx={{ mt: 2 }}>All device tests finished. Preparing the Houston diagnosis…</Alert>}
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2">Live line log</Typography>
              <Box component="pre" ref={logRef} onScroll={(event) => { const element = event.currentTarget; setLogPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 32); }} aria-live="polite" sx={{ maxHeight: 220, overflow: "auto", p: 1.5, mt: 1, borderRadius: 1, bgcolor: "#0b1322", color: "#a9c8f2", fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>{allLines.length > 0 ? allLines.join("\n") : "Waiting for NDJSON…"}</Box>
            </CardContent>
          </Card>
        )}

        {activeStep >= 4 && run && (
          <Card>
            <CardContent>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}>
                <Box>
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 4 · Find the problem</Typography>
                  <Typography variant="h6" sx={{ mt: 1, color: run.verdict === "pass" ? "success.main" : "warning.main" }}>{run.verdict === "pass" ? "Houston, we are GO." : run.diagnosis.summary}</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>Attribution: {run.diagnosis.attribution}. Candidates are ranked from the telemetry and the revision netlist.</Typography>
                </Box>
                <Chip label={run.verdict.toUpperCase()} color={run.verdict === "pass" ? "success" : "warning"} />
              </Stack>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
                <Box sx={{ flex: 1 }}>
                  {run.verdict === "pass" ? <Alert severity="success">No wiring fault found. The self-test agrees with the released design.</Alert> : run.verdict === "incomplete" ? <Alert severity="warning">We did not get an answer for {timedOutPrompt}. Nothing was blamed on your wiring. <Button color="inherit" size="small" onClick={restartSelfTest}>Run the self-test again</Button></Alert> : run.diagnosis.candidates.length === 0 ? <Alert severity="warning">No single wiring cause was identified. Check the highlighted area, then rerun the self-test.</Alert> : <Stack spacing={1}>{run.diagnosis.candidates.map((candidate, index) => <Button key={candidate.cause} variant={selectedCandidate === index ? "contained" : "outlined"} onClick={() => setSelectedCandidate(index)} sx={{ ...actionButtonSx, justifyContent: "space-between", textAlign: "left" }}><span>{index + 1}. {candidate.title}</span><span>{Math.round(candidate.likelihood * 100)}%</span></Button>)}</Stack>}
                  {run.verdict !== "pass" && run.verdict !== "incomplete" && (indistinguishable ? <Stack spacing={1} sx={{ mt: 2 }}>{run.diagnosis.candidates.slice(0, 2).map((candidate) => <Paper key={candidate.cause} variant="outlined" sx={{ p: 2 }}><Typography sx={{ fontWeight: 700 }}>{candidate.title}</Typography><Typography color="text.secondary">{candidate.fix}</Typography></Paper>)}</Stack> : topCandidate ? <Paper variant="outlined" sx={{ p: 2, mt: 2 }}><Typography sx={{ fontWeight: 700 }}>Recommended fix</Typography><Typography color="text.secondary">{topCandidate.fix}</Typography></Paper> : null)}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>Highlighted breadboard artifact</Typography>
                  <Box sx={{ "& svg": { display: "block", width: "100%", height: "auto", "& .vb-hl": { stroke: "#ff6b6b", strokeWidth: 3, filter: "drop-shadow(0 0 5px rgba(255,107,107,.8))" } } }} dangerouslySetInnerHTML={{ __html: decoratedSvg }} />
                </Box>
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
                <Button variant="outlined" onClick={restartSelfTest} disabled={Boolean(busy)} sx={actionButtonSx}>{run.verdict === "pass" ? "Run the self-test again" : "Fix wiring and rerun"}</Button>
                {run.verdict === "pass" && <Button variant="contained" onClick={() => void flashApp()} disabled={Boolean(busy)} sx={actionButtonSx}>{mode === "virtual" ? "Continue to celebration" : "Flash app firmware with calibration"}</Button>}
              </Stack>
            </CardContent>
          </Card>

        )}
        {activeStep >= 6 && (
          <Paper sx={{ p: { xs: 3, md: 6 }, textAlign: "center", overflow: "hidden", position: "relative", "@keyframes vb-liftoff": { from: { transform: "translateY(20px)", opacity: 0 }, to: { transform: "translateY(0)", opacity: 1 } }, animation: reducedMotion ? "none" : "vb-liftoff .8s ease-out" }}>
            <Typography variant="h2" sx={{ fontWeight: 900 }}>Mission verified</Typography>
            <Typography variant="h6" color="text.secondary" sx={{ mt: 1 }}>The bench telemetry agrees with the design. ViBread is GO for launch.</Typography>
            {mode === "virtual" && <><Typography variant="body2" sx={{ mt: 2 }}>Your project firmware is running on the virtual board.</Typography><Box sx={{ maxWidth: 720, mx: "auto", mt: 2, "& svg": { display: "block", width: "100%", height: "auto" } }} dangerouslySetInnerHTML={{ __html: decoratedSvg }} /></>}
            <Button component={Link} to={`/m/${missionId}`} variant="contained" sx={{ ...actionButtonSx, mt: 3 }}>Return to mission control</Button>
          </Paper>
        )}

        {mode === "physical" && (
          <Alert severity="info" icon={false}>
            <Typography sx={{ fontWeight: 700 }}>Laptop fallback</Typography>
            <Typography variant="body2">If this browser cannot use Web Serial, release the port and upload either server-built HEX on the laptop:</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
              {benchArtifactUrl && <Button component="a" href={benchArtifactUrl} download="bench.hex" variant="outlined" sx={actionButtonSx}>Download bench.hex</Button>}
              {appArtifactUrl && <Button component="a" href={appArtifactUrl} download="app.hex" variant="outlined" sx={actionButtonSx}>Download app.hex</Button>}
            </Stack>
            {fallbackUpload && <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ mt: 1, alignItems: { md: "center" } }}>
              <Box component="code" sx={{ display: "block", flex: 1, fontFamily: "monospace", overflowX: "auto" }}>{fallbackCommand(fallbackUpload)}</Box>
              <Button variant="outlined" size="small" onClick={() => void navigator.clipboard?.writeText(fallbackCommand(fallbackUpload))}>Copy command</Button>
            </Stack>}
            <Typography variant="body2" sx={{ mt: 1 }}>After flashing, connect the board here again to run the self-test.</Typography>
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
