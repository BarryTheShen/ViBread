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
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { Part, RevisionDetail } from "@vibread/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactText } from "../../api/hooks.js";
import { SvgArtifact } from "../../components/SvgArtifact.js";
import { MONO_FONT } from "../../theme.js";
import { BuzzerAudio, isSounding } from "../buzzerAudio.js";
import type { LiveSimInput, LiveSimOutput } from "../liveSimProtocol.js";
import { applyFrame, breadboardUrl, describePartState } from "../replay.js";

const FIDELITY =
  "Instruction-level ATmega328P emulation of the exact binary that will be flashed, with protocol-level part models. " +
  "Validates logic, timing, and pin configuration; does not prove current, noise, brown-out, or contact quality — the physical self-test does.";

const SERIAL_LIMIT = 4000;
const DEFAULT_LIGHT = 0.8;
const DEFAULT_KNOB = 0.5;

const partName = (p: Part) => (p.label ? `${p.id} (${p.label})` : p.id);

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

/** PLAN item 12: the revision's app.hex running live in the browser, driving the breadboard drawing. */
export function TryItTab({ revision }: { revision: RevisionDetail }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const hexUrl = revision.artifactUrls["app.hex"];
  const hex = useArtifactText(hexUrl);
  const board = breadboardUrl(revision.artifactUrls);
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
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState<Record<string, number>>({});
  const [knob, setKnob] = useState<Record<string, number>>({});
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const [runId, setRunId] = useState(0);
  const [muted, setMuted] = useState(true);
  const [soundHint, setSoundHint] = useState(false);
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
    const worker = new Worker(new URL("../liveSim.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let lastPaint = 0;
    worker.onmessage = (event: MessageEvent<LiveSimOutput>) => {
      const message = event.data;
      if (message.type === "state") {
        latest.current = message.parts;
        audio.current?.update(message.tones);
        if (mutedRef.current && isSounding(message.tones) && !sessionStorage.getItem(SOUND_HINT_KEY)) {
          sessionStorage.setItem(SOUND_HINT_KEY, "1");
          setSoundHint(true);
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
        setError(message.message);
      }
    };
    worker.onerror = (event) => setError(event.message || "The simulator stopped unexpectedly.");
    worker.postMessage({ type: "start", circuit, hex: hex.data, light: initialLight, analog: initialKnob } satisfies LiveSimInput);
    return () => {
      worker.postMessage({ type: "stop" } satisfies LiveSimInput);
      worker.terminate();
      workerRef.current = null;
      audio.current?.silence();
    };
    // Restart on a new revision, new hex, or Reset (runId); sensor/knob lists derive from the circuit.
  }, [hex.data, circuit, runId, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

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
              sx={{ minWidth: 118, justifyContent: "flex-start" }}
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
      {error && <Alert severity="error">The simulator stopped: {error}. Press Reset to start again.</Alert>}
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
          <Box key={p.id}>
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
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          Serial monitor (what the Arduino prints)
        </Typography>
        <Box
          component="pre"
          aria-label="Serial output"
          sx={{ m: 0, mt: 0.5, p: 1, bgcolor: "code.main", borderRadius: 1, fontFamily: MONO_FONT, fontSize: 12.5, height: 120, overflow: "auto", whiteSpace: "pre-wrap" }}
        >
          {serial || "Nothing printed yet."}
        </Box>
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
      <Snackbar open={soundHint} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} onClose={(_, why) => why !== "clickaway" && setSoundHint(false)}>
        <Alert
          severity="info"
          icon={<VolumeOffIcon />}
          onClose={() => setSoundHint(false)}
          action={
            <Button color="inherit" size="small" startIcon={<VolumeUpIcon />} onClick={() => toggleSound(false)}>
              Unmute
            </Button>
          }
        >
          Your board is making sound — unmute to hear it.
        </Alert>
      </Snackbar>
    </Stack>
  );
}
