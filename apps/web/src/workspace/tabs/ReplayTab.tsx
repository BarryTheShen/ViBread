import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ReplayIcon from "@mui/icons-material/Replay";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { RevisionDetail, Trace } from "@vibread/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useArtifactJson } from "../../api/hooks.js";
import { SvgArtifact } from "../../components/SvgArtifact.js";
import { applyFrame, breadboardUrl, describePartState, frameIndexAt } from "../replay.js";

/** Replays a recorded simulation trace on the breadboard drawing by toggling `glow-<ID>` / `sound-<ID>` opacity. */
export function ReplayTab({ revision }: { revision: RevisionDetail }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const traced = (revision.results.sim?.scenarios ?? []).filter((s) => s.traceKey && revision.artifactUrls[s.traceKey]);
  const [scenarioId, setScenarioId] = useState<string>("");
  const selected = traced.find((s) => s.id === scenarioId) ?? traced[0];
  const trace = useArtifactJson<Trace>(selected?.traceKey ? revision.artifactUrls[selected.traceKey] : undefined);
  const board = breadboardUrl(revision.artifactUrls);
  const svgRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frames = useMemo(() => trace.data?.frames ?? [], [trace.data]);
  const endT = frames.length ? frames[frames.length - 1].t : 0;
  const frame = frames.length ? frames[frameIndexAt(frames, t)] : undefined;
  const passive = useMemo(() => new Set(revision.circuit.parts.filter((p) => p.module === "resistor").map((p) => p.id)), [revision.circuit]);

  useEffect(() => {
    setT(0);
    setPlaying(false);
  }, [selected?.id]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= endT) {
          setPlaying(false);
          return endT;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, endT]);

  useEffect(() => {
    if (svgRef.current && frame) applyFrame(svgRef.current, frame);
  });

  if (traced.length === 0) {
    return <Alert severity="info">Replays appear after the simulation tests run with recording on.</Alert>;
  }
  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <FormControl size="small" sx={{ minWidth: 260, flex: 1 }}>
          <InputLabel id="replay-scenario-label">Test to replay</InputLabel>
          <Select labelId="replay-scenario-label" label="Test to replay" value={selected?.id ?? ""} onChange={(e) => setScenarioId(e.target.value)}>
            {traced.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.ok ? "Passed" : "Failed"} · {s.title}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained"
          startIcon={playing ? <PauseIcon /> : t >= endT && endT > 0 ? <ReplayIcon /> : <PlayArrowIcon />}
          disabled={frames.length === 0}
          onClick={() => {
            if (playing) return setPlaying(false);
            if (t >= endT) setT(0);
            setPlaying(true);
          }}
        >
          {playing ? "Pause" : t >= endT && endT > 0 ? "Play again" : "Play"}
        </Button>
      </Stack>
      {reducedMotion && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Reduced motion is on: nothing plays by itself. Drag the time slider to step through the test.
        </Typography>
      )}
      <Paper variant="outlined" sx={{ p: 1, bgcolor: "canvas.main" }}>
        {board ? (
          <SvgArtifact ref={svgRef} url={board} label="Breadboard replay" />
        ) : (
          <Alert severity="info">The breadboard drawing isn't ready yet; the part states below still replay.</Alert>
        )}
      </Paper>
      <Box sx={{ px: 1 }}>
        <Slider
          value={t}
          min={0}
          max={Math.max(endT, 1)}
          step={1}
          onChange={(_, v) => {
            setPlaying(false);
            setT(Array.isArray(v) ? v[0] : v);
          }}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `${(v / 1000).toFixed(2)} s`}
          aria-label="Simulation time"
          getAriaValueText={(v) => `${(v / 1000).toFixed(2)} seconds`}
        />
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {(t / 1000).toFixed(2)} s of {(endT / 1000).toFixed(2)} s simulated
        </Typography>
      </Box>
      {frame && (
        <Typography variant="body2" aria-live="off">
          {Object.entries(frame.parts)
            .filter(([part]) => !passive.has(part))
            .map(([part, value]) => describePartState(part, value))
            .join(" · ")}
        </Typography>
      )}
      {trace.isError && <Alert severity="error">Couldn't load the replay: {trace.error.message}</Alert>}
    </Stack>
  );
}
