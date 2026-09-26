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
import type { BenchRunResult, BoardProfileId, Circuit, DeviceLine, MissionDetail, RevisionDetail, SelfTestPlan } from "@vibread/core";
import { BOARD_PROFILES, revisionHash } from "@vibread/core";
import { evaluateRun, planSelfTest, promptFor } from "@vibread/bench";
import { BenchRunner, type BenchRunnerState } from "./runner.js";
import { circuitWithFault } from "./faults.js";
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

const STEPS = ["Connect board", "Safe firmware", "Rail checkpoint", "Self-test", "Diagnose", "App firmware", "Celebrate"];
const BOARD_LOST_POWER = "Board lost power — unplug, then check the rails and the cable";

interface FirmwareResponse {
  hex: string;
  design?: string;
  plan?: SelfTestPlan;
}

interface LoadedBench {
  mission: MissionDetail;
  revision: RevisionDetail;
  plan: SelfTestPlan;
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
    const response = await fetch(artifactUrl);
    if (response.ok) {
      const candidate = await response.text();
      if (candidate.includes("data-vibread=\"breadboard\"") || candidate.includes("data-vibread='breadboard'")) boardSvg = candidate;
    }
  }
  return { mission, revision, plan, boardSvg };
}

function progressText(progress: FlashProgress | undefined): string {
  if (!progress) return "Preparing the bootloader…";
  return `${progress.stage} · ${Math.round(progress.percent)}%`;
}

function isLostPowerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|serial|power|banner|timeout|port/i.test(message);
}

const actionButtonSx = { minHeight: 46, borderRadius: 2 } as const;

export default function BenchPage(): ReactElement {
  const { missionId = "" } = useParams<{ missionId: string }>();
  const [loaded, setLoaded] = useState<LoadedBench | undefined>();
  const [loadError, setLoadError] = useState<string>();
  const [mode, setMode] = useState<"physical" | "virtual">("virtual");
  const [boardProfileChoice, setBoardProfileChoice] = useState<BoardProfileId | "auto">("auto");
  const [fault, setFault] = useState<VirtualFault>("none");
  const [activeStep, setActiveStep] = useState(0);
  const [connection, setConnection] = useState<BoardPortConnection | undefined>();
  const [runnerState, setRunnerState] = useState<BenchRunnerState>();
  const [runner, setRunner] = useState<BenchRunner>();
  const [benchHex, setBenchHex] = useState<string>();
  const [flashProgress, setFlashProgress] = useState<FlashProgress>();
  const [telemetry, setTelemetry] = useState<VirtualPartTelemetry>();
  const [run, setRun] = useState<BenchRunResult>();
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [highlight, setHighlight] = useState<SvgHighlight>({ holes: [], parts: [], jumpers: [] });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [reducedMotion, setReducedMotion] = useState(false);
  const virtualRef = useRef<VirtualBenchTransport | undefined>(undefined);
  const connectionRef = useRef<BoardPortConnection | undefined>(undefined);
  const runnerRef = useRef<BenchRunner | undefined>(undefined);
  const railRequestAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setLoaded(undefined);
    setLoadError(undefined);
    if (!missionId) {
      setLoadError("No mission was selected.");
      return () => undefined;
    }
    loadBench(missionId)
      .then((value) => {
        if (alive) setLoaded(value);
      })
      .catch((reason: unknown) => {
        if (alive) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
      runnerRef.current?.dispose();
      void connectionRef.current?.transport.close();
      void virtualRef.current?.close();
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
      transport: nextTransport,
      onState: (next) => setRunnerState({ ...next }),
    });
    runnerRef.current = nextRunner;
    setRunner(nextRunner);
    setRunnerState(nextRunner.state);
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
      const virtual = new VirtualBenchTransport({
        onTelemetry: setTelemetry,
        onError: (message) => {
          setError(message);
          runnerRef.current?.fail(message);
        },
      });
      const simulatedCircuit = circuitWithFault(loaded.revision.circuit, fault);
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
      const firmware = benchHex ? { hex: benchHex } : await firmwareFor(missionId, "bench");
      setBenchHex(firmware.hex);
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
  }, [benchHex, connection, loaded, missionId, mode, runner]);

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
          body: JSON.stringify(request),
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
      if (mode === "physical") {
        const selected = connectionRef.current;
        if (!selected) throw new Error("Connect the board before flashing app firmware.");
        await flashHex({ connection: selected, hex: firmware.hex, onProgress: setFlashProgress });
      }
      setFlashProgress({ stage: mode === "virtual" ? "Virtual flash skipped" : "verified", percent: 100 });
      setActiveStep(6);
    } catch (reason: unknown) {
      const message = isLostPowerError(reason) ? BOARD_LOST_POWER : reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }, [loaded, missionId, mode]);

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
    const simulatedCircuit = circuitWithFault(loaded.revision.circuit, fault);
    const nextRunner = attachRunner(virtualRef.current, loaded.plan, simulatedCircuit, loaded.revision.n);
    virtualRef.current.start({ circuit: simulatedCircuit, hex: benchHex, fault });
    setRunner(nextRunner);
    setRunnerState(nextRunner.state);
    setRun(undefined);
    setError(undefined);
    setActiveStep(1);
  }, [attachRunner, benchHex, fault, loaded, mode]);

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
  const topCandidate = run?.diagnosis.candidates[selectedCandidate];
  const allLines = runnerState?.rawLines ?? [];
  const currentProfile = connection?.profile;

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
                <Typography color="text.secondary" sx={{ mt: 0.5 }}>Physical actions stay behind an explicit click in this page. Virtual mode runs the same NDJSON firmware loop in a Web Worker.</Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                <Button variant={mode === "virtual" ? "contained" : "outlined"} onClick={() => setMode("virtual")} sx={actionButtonSx}>Try without a board</Button>
                <Button variant={mode === "physical" ? "contained" : "outlined"} onClick={() => setMode("physical")} sx={actionButtonSx}>Use USB board</Button>
              </Stack>
            </Stack>
            {mode === "virtual" && (
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2, alignItems: { md: "flex-end" } }}>
                <FormControl size="small" sx={{ minWidth: 290 }}>
                  <InputLabel id="virtual-fault-label">Inject a wiring fault</InputLabel>
                  <Select labelId="virtual-fault-label" value={fault} label="Inject a wiring fault" onChange={(event) => setFault(event.target.value as VirtualFault)}>
                    <MenuItem value="none">{faultLabel("none")}</MenuItem>
                    <MenuItem value="button-gnd">{faultLabel("button-gnd")}</MenuItem>
                    <MenuItem value="led-jumpers">{faultLabel("led-jumpers")}</MenuItem>
                    <MenuItem value="divider-resistor">{faultLabel("divider-resistor")}</MenuItem>
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

        {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}

        {activeStep >= 1 && (
          <Card>
            <CardContent>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 1 · Safe firmware</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>Before the breadboard is trusted, every pin becomes an input. The firmware banner is tied to design hash <strong>{loaded.revision.hash.slice(0, 12)}</strong>.</Typography>
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
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 2 · Rail checkpoint</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>The board must print a matching hello banner and a normal VCC reading before any output is driven.</Typography>
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
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 3 · Self-test</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>Read-only checks run first. LED pulses stay below 5 ms and 10% duty.</Typography>
                </Box>
                <Chip label={`${runnerState?.lines.length ?? 0} telemetry lines`} color="info" variant="outlined" />
              </Stack>
              {pendingAsks.length > 0 && (
                <Stack spacing={2} sx={{ mt: 2 }}>
                  {pendingAsks.map((ask) => {
                    const prompt = promptFor(ask, loaded.plan);
                    return <Paper key={ask.id} sx={{ p: 2.5, border: "2px solid", borderColor: "secondary.main", background: "rgba(101,78,163,.15)" }}>
                      <Typography variant="h6" sx={{ fontWeight: 700 }}>{prompt.title}</Typography>
                      <Typography color="text.secondary" sx={{ mb: 2 }}>{prompt.body}</Typography>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
                        {prompt.choices.map((choice) => <Button key={choice.value} variant="contained" onClick={() => void answerAsk(ask.id, choice.value)} disabled={Boolean(busy)} sx={actionButtonSx}>{choice.label}</Button>)}
                      </Stack>
                    </Paper>;
                  })}
                </Stack>
              )}
              {runnerState?.done && <Alert severity="info" sx={{ mt: 2 }}>All device tests finished. Preparing the Houston diagnosis…</Alert>}
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2">Live line log</Typography>
              <Box component="pre" aria-live="polite" sx={{ maxHeight: 220, overflow: "auto", p: 1.5, mt: 1, borderRadius: 1, bgcolor: "#0b1322", color: "#a9c8f2", fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>{allLines.length > 0 ? allLines.join("\n") : "Waiting for NDJSON…"}</Box>
            </CardContent>
          </Card>
        )}

        {activeStep >= 4 && run && (
          <Card>
            <CardContent>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}>
                <Box>
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>Step 4 · Diagnose</Typography>
                  <Typography variant="h6" sx={{ mt: 1, color: run.verdict === "pass" ? "success.main" : "warning.main" }}>{run.verdict === "pass" ? "Houston, we are GO." : run.diagnosis.summary}</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>Attribution: {run.diagnosis.attribution}. Candidates are ranked from the telemetry and the revision netlist.</Typography>
                </Box>
                <Chip label={run.verdict.toUpperCase()} color={run.verdict === "pass" ? "success" : "warning"} />
              </Stack>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
                <Box sx={{ flex: 1 }}>
                  {run.diagnosis.candidates.length === 0 ? <Alert severity="success">No candidate wiring faults. The self-test agrees with the released design.</Alert> : <Stack spacing={1}>{run.diagnosis.candidates.map((candidate, index) => <Button key={candidate.cause} variant={selectedCandidate === index ? "contained" : "outlined"} onClick={() => setSelectedCandidate(index)} sx={{ ...actionButtonSx, justifyContent: "space-between", textAlign: "left" }}><span>{index + 1}. {candidate.title}</span><span>{Math.round(candidate.likelihood * 100)}%</span></Button>)}</Stack>}
                  {topCandidate && <Paper variant="outlined" sx={{ p: 2, mt: 2 }}><Typography sx={{ fontWeight: 700 }}>Recommended fix</Typography><Typography color="text.secondary">{topCandidate.fix}</Typography></Paper>}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>Highlighted breadboard artifact</Typography>
                  <Box sx={{ "& svg": { display: "block", width: "100%", height: "auto", "& .vb-hl": { stroke: "#ff6b6b", strokeWidth: 3, filter: "drop-shadow(0 0 5px rgba(255,107,107,.8))" } } }} dangerouslySetInnerHTML={{ __html: decoratedSvg }} />
                </Box>
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
                <Button variant="outlined" onClick={() => { setRun(undefined); setActiveStep(3); }} sx={actionButtonSx}>Fix wiring and rerun</Button>
                {run.verdict === "pass" && <Button variant="contained" onClick={() => void flashApp()} disabled={Boolean(busy)} sx={actionButtonSx}>{mode === "virtual" ? "Continue to celebration" : "Flash app firmware with calibration"}</Button>}
              </Stack>
            </CardContent>
          </Card>

        )}
        {activeStep >= 6 && (
          <Paper sx={{ p: { xs: 3, md: 6 }, textAlign: "center", overflow: "hidden", position: "relative", "@keyframes vb-liftoff": { from: { transform: "translateY(20px)", opacity: 0 }, to: { transform: "translateY(0)", opacity: 1 } }, animation: reducedMotion ? "none" : "vb-liftoff .8s ease-out" }}>
            <Typography variant="h2" sx={{ fontWeight: 900 }}>Mission verified</Typography>
            <Typography variant="h6" color="text.secondary" sx={{ mt: 1 }}>The bench telemetry agrees with the design. ViBread is GO for launch.</Typography>
            <Button component={Link} to={`/m/${missionId}`} variant="contained" sx={{ ...actionButtonSx, mt: 3 }}>Return to mission control</Button>
          </Paper>
        )}

        {mode === "physical" && (
          <Alert severity="info" icon={false}>
            <Typography sx={{ fontWeight: 700 }}>Laptop fallback</Typography>
            <Typography variant="body2">If this browser cannot use Web Serial, release the port and run the server-built HEX on the laptop:</Typography>
            <Box component="code" sx={{ display: "block", mt: 1, fontFamily: "monospace", overflowX: "auto" }}>arduino-cli upload --input-file &lt;server-built-hex&gt;</Box>
            <Typography variant="body2" sx={{ mt: 1 }}>This fallback is intentionally outside the browser; reconnect here afterward to read the NDJSON self-test.</Typography>
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
