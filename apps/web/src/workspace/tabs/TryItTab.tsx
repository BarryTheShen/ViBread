import RestartAltIcon from "@mui/icons-material/RestartAlt";
import TouchAppIcon from "@mui/icons-material/TouchApp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { Part, RevisionDetail } from "@vibread/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactText, useBuildState } from "../../api/hooks.js";
import { reportClientError } from "../../components/ClientErrorReporter.js";
import { SvgArtifact } from "../../components/SvgArtifact.js";
import { SERIAL_LIMIT, SerialMonitor } from "../../components/SerialMonitor.js";
import { reloadForStaleChunk } from "../../staleChunks.js";
import { WEB_VERSION, type VersionInfo } from "../../version.js";

import { BuzzerAudio, isSounding } from "../buzzerAudio.js";
import type { LiveSimInput, LiveSimOutput } from "../liveSimProtocol.js";
import { applyFrame, breadboardUrl, describePartState } from "../replay.js";

const FIDELITY =
  "Instruction-level ATmega328P emulation of the exact binary that will be flashed, with protocol-level part models. " +
  "Validates logic, timing, and pin configuration; does not prove current, noise, brown-out, or contact quality — the physical self-test does.";

const DEFAULT_LIGHT = 0.8;
const DEFAULT_KNOB = 0.5;

const partName = (p: Part) => (p.label ? `${p.id} (${p.label})` : p.id);

/** Why the board isn't running: it stopped (Reset restarts it), or its worker script never loaded (only a reload helps). */
type SimProblem = { kind: "stopped"; reason?: string } | { kind: "not-loaded"; updated: boolean };

/** An error text as one sentence for the banner: the browser's "Uncaught " dropped, exactly one full stop. */
function sentence(text: string): string {
  const trimmed = text.replace(/^Uncaught\s+/, "").replace(/[.\s]+$/, "");
  return /[!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Whether the server now serves a different build than this page's. A redeploy renames the hashed worker script, so a
 * tab opened before it asks for a file that no longer exists (and gets the app's HTML back); a plain `error` event with
 * no message is all the page hears.
 */
async function appWasUpdated(): Promise<boolean> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return false;
    const served = (await response.json()) as Partial<VersionInfo>;
    return typeof served.builtAt === "string" && (served.builtAt !== WEB_VERSION.builtAt || served.commit !== WEB_VERSION.commit);
  } catch {
    // No version.json (the dev server answers with HTML): not a redeploy we can detect.
    return false;
  }
}

/** A percentage in a fixed-width slot so "8%" → "100%" doesn't reflow the label. */
function Percent({ value }: { value: number }) {
  return (
    <Box component="span" sx={{ display: "inline-block", minWidth: "4ch", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
      {Math.round(value * 100)}%
    </Box>
  );
}

/** Press-and-hold control: pointer or Space/Enter held = button pressed. Same label pressed or not, so nothing shifts. */
function HoldButton({ part, pressed, onChange }: { part: Part; pressed: boolean; onChange(pressed: boolean): void }) {
  return (
    <Button
      variant={pressed ? "contained" : "outlined"}
      startIcon={<TouchAppIcon />}
      aria-pressed={pressed}
      data-tour="tryit-button"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(true);
      }}
      onPointerUp={() => onChange(false)}
      onPointerCancel={() => onChange(false)}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          onChange(true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") onChange(false);
      }}
      onBlur={() => onChange(false)}
      sx={{ minHeight: 44, touchAction: "none", userSelect: "none", justifyContent: "flex-start", textAlign: "left" }}
    >
      Hold to press {partName(part)}
    </Button>
  );
}

const SOUND_HINT_KEY = "vibread:tryit-sound-hint-shown";
/** The unmute hint hides once the buzzer has been silent this long. */
const SOUND_HINT_QUIET_MS = 2_000;

/** PLAN item 12: the revision's app.hex running live in the browser, driving the breadboard drawing. */
export function TryItTab({ missionId, revision, released }: { missionId: string; revision: RevisionDetail; released: boolean }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const hexUrl = revision.artifactUrls["app.hex"];
  const hex = useArtifactText(hexUrl);
  // The build target is drawn with the builder's wire colours; other revisions use their pipeline drawing.
  const build = useBuildState(missionId, released);
  const board = (build.data?.revision === revision.n ? build.data.wires?.breadboardUrl : undefined) ?? breadboardUrl(revision.artifactUrls);
  const { circuit } = revision;
  const buttons = useMemo(() => circuit.parts.filter((p) => p.module === "button"), [circuit]);
  const sensors = circuit.parts.filter((p) => p.module === "photoresistor");
  const knobs = circuit.parts.filter((p) => p.module === "potentiometer");
  const hasBuzzer = circuit.parts.some((p) => p.module.startsWith("buzzer"));
  const shown = useMemo(() => circuit.parts.filter((p) => p.module !== "resistor"), [circuit]);

  const svgRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef<Record<string, number>>({});
  const audio = useRef<BuzzerAudio | null>(null);
  const diagramPointers = useRef(new Map<number, string>());
  const [parts, setParts] = useState<Record<string, number>>({});
  const [timeMs, setTimeMs] = useState(0);
  const [serial, setSerial] = useState("");
  const [line, setLine] = useState("");
  const [error, setError] = useState<SimProblem | null>(null);
  const [light, setLight] = useState<Record<string, number>>({});
  const [knob, setKnob] = useState<Record<string, number>>({});
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const [runId, setRunId] = useState(0);
  const [muted, setMuted] = useState(true);
  const [soundHint, setSoundHint] = useState(false);
  /** When the buzzer last made sound: the unmute hint steps aside after a quiet spell (it shows once per session). */
  const lastSoundAt = useRef(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const send = useCallback((message: LiveSimInput) => workerRef.current?.postMessage(message), []);
  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  // Side buttons and the PRESS buttons on the drawing drive the same input; only real changes reach the simulator.
  const setButton = useCallback(
    (part: string, value: boolean) => {
      if ((pressedRef.current[part] ?? false) === value) return;
      pressedRef.current = { ...pressedRef.current, [part]: value };
      setPressed(pressedRef.current);
      send({ type: "digital", part, value });
    },
    [send],
  );

  // One speaker per mounted tab: muted by default; disposed (all sound stopped) on panel close and navigation.
  useEffect(() => {
    const speaker = new BuzzerAudio();
    audio.current = speaker;
    const onVisibility = () => speaker.setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      speaker.dispose();
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    if (!hex.data) return;
    const initialLight = Object.fromEntries(sensors.map((p) => [p.id, DEFAULT_LIGHT]));
    const initialKnob = Object.fromEntries(knobs.map((p) => [p.id, DEFAULT_KNOB]));
    setLight(initialLight);
    setKnob(initialKnob);
    setSerial("");
    setError(null);
    pressedRef.current = {};
    setPressed({});
    let disposed = false;
    const worker = new Worker(new URL("../liveSim.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let lastPaint = 0;
    worker.onmessage = (event: MessageEvent<LiveSimOutput>) => {
      const message = event.data;
      if (message.type === "state") {
        latest.current = message.parts;
        audio.current?.update(message.tones);
        if (isSounding(message.tones)) {
          lastSoundAt.current = performance.now();
          if (mutedRef.current && !sessionStorage.getItem(SOUND_HINT_KEY)) {
            sessionStorage.setItem(SOUND_HINT_KEY, "1");
            setSoundHint(true);
          }
        }
        if (!reducedMotion && svgRef.current) applyFrame(svgRef.current, message);
        const now = performance.now();
        if (now - lastPaint > 120) {
          lastPaint = now;
          setParts(message.parts);
          setTimeMs(message.timeMs);
        }
      } else if (message.type === "serial") {
        setSerial((s) => (s + message.text).slice(-SERIAL_LIMIT));
      } else if (message.type === "error") {
        console.error(`Try it simulator stopped: ${message.message}`, message.stack ?? "");
        reportClientError({ message: `Try it simulator stopped: ${message.message}`, stack: message.stack });
        setError({ kind: "stopped", reason: message.message });
      }
    };
    worker.onerror = (event: ErrorEvent | Event) => {
      if (event instanceof ErrorEvent && event.message) {
        // The worker reports its own errors as messages, so this is one that escaped it; `error` is null across the boundary.
        const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
        console.error(`Try it simulator stopped: ${event.message}${where}`, event.error ?? "");
        reportClientError({ message: `Try it simulator stopped: ${event.message}${where}`, stack: event.error instanceof Error ? event.error.stack : undefined });
        setError({ kind: "stopped", reason: event.message });
        return;
      }
      // A plain Event: the worker script itself didn't load, and the browser gives no reason.
      console.error("Try it simulator: its worker script failed to load", event);
      void appWasUpdated().then((updated) => {
        if (disposed) return;
        reportClientError({ message: `Try it simulator: its worker script failed to load${updated ? " (a newer ViBread build is being served)" : ""}` });
        if (updated && reloadForStaleChunk()) return;
        setError({ kind: "not-loaded", updated });
      });
    };
    worker.postMessage({ type: "start", circuit, hex: hex.data, light: initialLight, analog: initialKnob } satisfies LiveSimInput);
    return () => {
      disposed = true;
      worker.postMessage({ type: "stop" } satisfies LiveSimInput);
      worker.terminate();
      workerRef.current = null;
      audio.current?.silence();
    };
    // Restart on a new revision, new hex, or Reset (runId); sensor/knob lists derive from the circuit.
  }, [hex.data, circuit, runId, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // The worker may stop posting frames once the board is idle, so poll the quiet time instead of waiting for a frame.
  useEffect(() => {
    if (!soundHint) return;
    const timer = window.setInterval(() => {
      if (performance.now() - lastSoundAt.current >= SOUND_HINT_QUIET_MS) setSoundHint(false);
    }, 250);
    return () => window.clearInterval(timer);
  }, [soundHint]);

  // Show presses on the drawing's own buttons too.
  useEffect(() => {
    for (const p of buttons) svgRef.current?.querySelector(`[id="part-${p.id}"]`)?.classList.toggle("vb-pressed", pressed[p.id] ?? false);
  }, [pressed, buttons]);

  // A new drawing (Layout re-renders) must show the current state immediately, not wait for the next change.
  const onSvgMounted = useCallback(
    (node: HTMLDivElement | null) => {
      svgRef.current = node;
      if (node && !reducedMotion) applyFrame(node, { parts: latest.current });
    },
    [reducedMotion],
  );

  const toggleSound = (next: boolean) => {
    setMuted(next);
    audio.current?.setMuted(next);
    if (!next) setSoundHint(false);
  };

  /** The button part under a pointer on the drawing, if any. */
  const diagramButtonAt = (target: EventTarget): string | undefined => {
    if (!(target instanceof Element)) return undefined;
    const id = target.closest('[id^="part-"]')?.id.slice("part-".length);
    return buttons.some((p) => p.id === id) ? id : undefined;
  };
  const releaseDiagramPointer = (pointerId: number) => {
    const part = diagramPointers.current.get(pointerId);
    if (part === undefined) return;
    diagramPointers.current.delete(pointerId);
    setButton(part, false);
  };
  const buttonSelector = buttons.map((p) => `& [id="part-${p.id}"]`).join(", ");

  if (!hexUrl) return <Alert severity="info">"Try it" needs compiled code. It appears once this design compiles.</Alert>;
  if (hex.isError) return <Alert severity="error">Couldn't load the compiled code: {hex.error.message}</Alert>;
  if (hex.isPending) return <Skeleton variant="rounded" height={320} aria-label="Loading the simulator" />;

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography variant="h6" component="h2">
            Try it before you build it
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Your exact code runs here in a simulated Arduino, in real time. Press buttons and change the light to see what it does.
          </Typography>
        </Box>
        {hasBuzzer && (
          <Tooltip title={muted ? "Sound is off. Turn it on to hear the buzzer." : "Sound is on. Turn it off."}>
            <Button
              variant="outlined"
              aria-pressed={!muted}
              startIcon={muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
              onClick={() => toggleSound(!muted)}
              // Fixed width: "Sound off" and "Sound on" differ by a few pixels and must not shift Reset.
              sx={{ width: 136, flexShrink: 0, justifyContent: "flex-start" }}
            >
              {muted ? "Sound off" : "Sound on"}
            </Button>
          </Tooltip>
        )}
        <Button
          startIcon={<RestartAltIcon />}
          variant="outlined"
          onClick={() => {
            audio.current?.silence();
            setRunId((n) => n + 1);
          }}
        >
          Reset
        </Button>
      </Stack>
      {error?.kind === "stopped" && (
        <Alert severity="error">
          {error.reason ? `The simulator stopped: ${sentence(error.reason)}` : "The simulator stopped unexpectedly."} Press Reset to start again.
        </Alert>
      )}
      {error?.kind === "not-loaded" && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          }
        >
          {error.updated
            ? "ViBread was updated since this page opened, so the simulator couldn't load. Reload the page to run it."
            : "The simulator's code couldn't load. Reload the page to try again."}
        </Alert>
      )}
      <Paper
        variant="outlined"
        onPointerDown={(e) => {
          const part = diagramButtonAt(e.target);
          if (part === undefined) return;
          e.preventDefault();
          diagramPointers.current.set(e.pointerId, part);
          setButton(part, true);
        }}
        // Sliding off the button releases it, like lifting a finger.
        onPointerMove={(e) => {
          const part = diagramPointers.current.get(e.pointerId);
          if (part !== undefined && diagramButtonAt(e.target) !== part) releaseDiagramPointer(e.pointerId);
        }}
        onPointerUp={(e) => releaseDiagramPointer(e.pointerId)}
        onPointerCancel={(e) => releaseDiagramPointer(e.pointerId)}
        onPointerLeave={(e) => releaseDiagramPointer(e.pointerId)}
        sx={{
          position: "relative",
          p: 1,
          bgcolor: "canvas.main",
          ...(buttonSelector ? { [buttonSelector]: { cursor: "pointer", touchAction: "none", userSelect: "none" } } : {}),
          "& .vb-pressed .button-cap": { fill: "#7A1414" },
          "& .vb-pressed .button-body": { stroke: "var(--mui-palette-primary-main)", strokeWidth: 3 },
        }}
      >
        {board ? (
          <SvgArtifact ref={onSvgMounted} url={board} label="Live breadboard simulation. The PRESS buttons on the drawing can be held down." />
        ) : (
          <Alert severity="info">The breadboard drawing isn't ready yet; the part states below are live.</Alert>
        )}
        {/* Over the drawing's top corner, inside the panel: never covers the controls and never moves them. */}
        {soundHint && (
          <Alert
            role="status"
            severity="info"
            variant="filled"
            icon={<VolumeOffIcon />}
            onClose={() => setSoundHint(false)}
            onPointerDown={(e) => e.stopPropagation()}
            action={
              <Button color="inherit" size="small" startIcon={<VolumeUpIcon />} onClick={() => toggleSound(false)} sx={{ whiteSpace: "nowrap" }}>
                Unmute
              </Button>
            }
            sx={{ position: "absolute", top: 12, right: 12, left: { xs: 12, sm: "auto" }, maxWidth: 420, boxShadow: 3, alignItems: "center" }}
          >
            Your board is making sound — unmute to hear it.
          </Alert>
        )}
      </Paper>
      {/* Fixed grid cells: a part changing state never moves the others. */}
      <Box component="ul" aria-label="Part states" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 0.5 }}>
        {shown.map((p) => (
          <Box component="li" key={p.id} sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {describePartState(p.id, parts[p.id] ?? 0)}
          </Box>
        ))}
      </Box>
      {reducedMotion && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Reduced motion is on, so the drawing doesn't light up; the line above shows each part's state.
        </Typography>
      )}
      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
        {buttons.length > 0 && (
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 1 }}>
            {buttons.map((p) => (
              <HoldButton key={p.id} part={p} pressed={pressed[p.id] ?? false} onChange={(value) => setButton(p.id, value)} />
            ))}
          </Box>
        )}
        {sensors.map((p) => (
          <Box key={p.id} data-tour="tryit-light">
            <Typography id={`light-${p.id}`} variant="body2" sx={{ fontWeight: 600 }}>
              Room light at {partName(p)}: <Percent value={light[p.id] ?? DEFAULT_LIGHT} />
            </Typography>
            <Slider
              aria-labelledby={`light-${p.id}`}
              value={light[p.id] ?? DEFAULT_LIGHT}
              min={0}
              max={1}
              step={0.01}
              marks={[
                { value: 0, label: "Dark" },
                { value: 1, label: "Bright" },
              ]}
              getAriaValueText={(v) => `${Math.round(v * 100)} percent light`}
              onChange={(_, v) => {
                const level = Array.isArray(v) ? v[0] : v;
                setLight((s) => ({ ...s, [p.id]: level }));
                send({ type: "light", part: p.id, level });
              }}
              sx={{ mx: 1, width: "calc(100% - 16px)" }}
            />
          </Box>
        ))}
        {knobs.map((p) => (
          <Box key={p.id}>
            <Typography id={`knob-${p.id}`} variant="body2" sx={{ fontWeight: 600 }}>
              Knob {partName(p)}: <Percent value={knob[p.id] ?? DEFAULT_KNOB} />
            </Typography>
            <Slider
              aria-labelledby={`knob-${p.id}`}
              value={knob[p.id] ?? DEFAULT_KNOB}
              min={0}
              max={1}
              step={0.01}
              getAriaValueText={(v) => `knob at ${Math.round(v * 100)} percent`}
              onChange={(_, v) => {
                const value = Array.isArray(v) ? v[0] : v;
                setKnob((s) => ({ ...s, [p.id]: value }));
                send({ type: "analog", part: p.id, value });
              }}
              sx={{ mx: 1, width: "calc(100% - 16px)" }}
            />
          </Box>
        ))}
        {buttons.length + sensors.length + knobs.length === 0 && (
          <Typography variant="body2">This design has no buttons, light sensors, or knobs to play with; just watch it run.</Typography>
        )}
        <Typography variant="caption" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
          Simulated time {(timeMs / 1000).toFixed(1)} s
        </Typography>
      </Paper>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <SerialMonitor value={serial} />
        <Stack
          component="form"
          direction="row"
          sx={{ gap: 1, mt: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!line) return;
            send({ type: "serial", text: `${line}\n` });
            setLine("");
          }}
        >
          <TextField size="small" label="Send to the Arduino" value={line} onChange={(e) => setLine(e.target.value)} sx={{ flex: 1 }} />
          <Button type="submit" variant="outlined" disabled={!line}>
            Send
          </Button>
        </Stack>
      </Paper>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        About this simulation: {FIDELITY}
      </Typography>
    </Stack>
  );
}
