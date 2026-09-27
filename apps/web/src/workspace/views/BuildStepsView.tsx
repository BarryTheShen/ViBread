import CheckIcon from "@mui/icons-material/Check";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import PowerIcon from "@mui/icons-material/Power";
import PowerOffIcon from "@mui/icons-material/PowerOff";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BuildState, InventoryItem, RevisionDetail } from "@vibread/core";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { sendJson } from "../../api/client.js";
import { queryKeys, useBuildState } from "../../api/hooks.js";
import { checkpointChecksForRevision, checkpointChecksPass, checkpointStatusText, checkpointTests, isFullSelfTestStep, type CheckpointCheck } from "../../build/checkpointChecks.js";
import { needVsHave } from "../../inventory/PartsView.js";
import { RepeatChecklist } from "../../build/RepeatChecklist.js";
import { SvgArtifact } from "../../components/SvgArtifact.js";
import { PhoneQr } from "../PhoneLink.js";
import { StepWireChips, WireColorPicker, WireLegend, useWireColor, type WireTarget } from "../WireColors.js";

const buildKey = (missionId: string) => ["mission", missionId, "build"] as const;

function GatherParts({ revision, inventory }: { revision: RevisionDetail; inventory: InventoryItem[] }) {
  const rows = needVsHave(revision.circuit.parts, inventory);
  const missing = rows.filter((r) => r.have < r.need);
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        What the design needs vs this mission's parts list
      </Typography>
      {/* The counts are the parts attached to this mission when it was created, not the live Inventory page. */}
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Counted from the parts list saved with this mission (your Inventory page may have changed since).
      </Typography>
      <List dense disablePadding>
        {rows.map((r) => (
          <ListItem key={r.key} disableGutters>
            <ListItemIcon sx={{ minWidth: 32 }}>
              {r.have >= r.need ? <TaskAltIcon color="success" fontSize="small" /> : <ReportProblemOutlinedIcon color="warning" fontSize="small" />}
            </ListItemIcon>
            <ListItemText primary={r.label} secondary={`need ${r.need} · ${r.have} in this mission's parts list${r.have < r.need ? ` — missing ${r.need - r.have}` : ""}`} />
          </ListItem>
        ))}
      </List>
      {missing.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mt: 1 }}
          action={
            <Button
              size="small"
              sx={{ whiteSpace: "nowrap" }}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("vibread:ask-agent", {
                    detail: { text: `I don't have ${missing.map((r) => `${r.need - r.have}× ${r.label}`).join(", ")}. Please redesign without it.` },
                  }),
                )
              }
            >
              Ask Claude to redesign
            </Button>
          }
        >
          Some parts aren't in this mission's parts list.
        </Alert>
      )}
    </Box>
  );
}
function CheckpointChecklist({
  checks,
  onRun,
}: {
  checks: CheckpointCheck[];
  onRun: () => void;
}) {
  const passed = checkpointChecksPass(checks);
  return (
    <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <TaskAltIcon color="info" aria-hidden="true" />
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Checks for this checkpoint
        </Typography>
      </Stack>
      <List dense disablePadding sx={{ mt: 0.5 }}>
        {checks.map((check) => {
          const Icon = check.status === "pass" ? CheckIcon : check.status === "fail" ? ReportProblemOutlinedIcon : check.status === "manual" ? VisibilityOutlinedIcon : check.status === "incomplete" ? ReplayOutlinedIcon : TaskAltIcon;
          const status = checkpointStatusText(check.status);
          return (
            <ListItem key={check.id} disableGutters>
              <ListItemIcon sx={{ minWidth: 34 }}>
                <Icon color={check.status === "pass" ? "success" : check.status === "fail" ? "error" : "disabled"} aria-hidden="true" />
              </ListItemIcon>
              <ListItemText primary={check.expected} secondary={check.diagnosis ? `${status} — ${check.diagnosis}` : status} />
            </ListItem>
          );
        })}
      </List>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap", mt: 1 }}>
        <Button variant="outlined" onClick={onRun} sx={{ minHeight: 44 }}>
          Run these checks
        </Button>
        {!passed && <Typography variant="caption" color="text.secondary">Done unlocks when every check passes.</Typography>}
      </Stack>
    </Paper>
  );
}


/**
 * Build steps (plan §4): step picture, holes, parts, USB state, "I did this" on the laptop (stays in sync with the phone,
 * both poll), and the phone QR. Follows the builder: jumps to BuildState.current whenever it changes.
 */
export function BuildStepsView({
  missionId,
  revision,
  released,
  inventory,
}: {
  missionId: string;
  revision: RevisionDetail;
  released: boolean;
  inventory: InventoryItem[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const steps = revision.results.steps?.steps ?? [];
  const [index, setIndex] = useState(0);
  const stepNav = useRef<HTMLDivElement>(null);
  const build = useBuildState(missionId, released);
  const current = released && build.data?.revision === revision.n ? build.data.current : undefined;
  useEffect(() => setIndex(current !== undefined ? Math.max(0, current - 1) : 0), [revision.n, current]);
  const step = steps.length > 0 ? steps[Math.min(index, steps.length - 1)] : undefined;
  const checkpointChecks = step?.checkpoint
      ? checkpointChecksForRevision({
          circuit: revision.circuit,
          revisionHash: revision.hash,
          tests: step.checkpoint.tests,
          plan: revision.results.selftest,
          runs: revision.results.bench,
          fullSelfTest: isFullSelfTestStep(step),
          step: step.n,
          layout: revision.results.layout,
        })
    : [];
  const checksPassed = !step?.checkpoint || checkpointChecksPass(checkpointChecks);
  const runCheckpointChecks = () => {
    if (!step?.checkpoint) return;
    // Exactly the checks shown above (the Final power-up lists the whole plan, not just the step's own tests).
    const tests = checkpointTests(checkpointChecks).join(",");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    navigate(`/m/${encodeURIComponent(missionId)}?panel=bench&tests=${encodeURIComponent(tests)}&step=${step.n}&returnTo=${encodeURIComponent(returnTo)}`);
  };
  useEffect(() => {
    if (!step) return;
    // The nav row, not the card: scrolling the card to the top hid Previous/Next above it after every step change.
    // "nearest" leaves a visible row alone and brings it back to the top when the builder had scrolled down to Done.
    stepNav.current?.scrollIntoView({ block: "nearest" });
  }, [step?.n]);

  const didThis = useMutation({
    mutationFn: (n: number) => sendJson<BuildState>("POST", `/api/missions/${encodeURIComponent(missionId)}/build/step`, { n }),
    // Optimistic: move the builder on at once; the server answer (or the next poll) is the truth.
    onMutate: async (n) => {
      await qc.cancelQueries({ queryKey: buildKey(missionId) });
      const before = qc.getQueryData<BuildState>(buildKey(missionId));
      if (before) qc.setQueryData<BuildState>(buildKey(missionId), { ...before, current: Math.min(n + 1, before.steps.length) });
      return { before };
    },
    onError: (_error, _n, context) => {
      if (context?.before) qc.setQueryData(buildKey(missionId), context.before);
    },
    onSuccess: (state) => qc.setQueryData(buildKey(missionId), state),
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.mission(missionId) }),
  });

  const liveBuild = build.data?.revision === revision.n ? build.data : undefined;
  const wires = liveBuild?.wires;
  const setWireColor = useWireColor(missionId, buildKey(missionId));
  const [picker, setPicker] = useState<{ target: WireTarget; anchor: { top: number; left: number } } | null>(null);
  const openPicker = (target: WireTarget, anchor: { top: number; left: number }) => setPicker({ target, anchor });

  if (steps.length === 0) {
    return <Alert severity="info">Build steps appear here once the design passes its checks and is laid out on the breadboard.</Alert>;
  }
  if (!step) return null;
  const liveStep = liveBuild?.steps.find((candidate) => candidate.n === step.n);
  const image = revision.artifactUrls[`step-${step.n}.svg`] ?? revision.artifactUrls[`step-${step.n}.png`];
  const canMark = released && current !== undefined && step.n >= current;
  return (
    <Stack sx={{ gap: 2 }}>
      {!released && (
        <Alert severity="warning">Preview only: this design isn't the build target yet. Press GO for build to start building it.</Alert>
      )}
      <Stack ref={stepNav} direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Button startIcon={<NavigateBeforeIcon />} disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
          Previous
        </Button>
        <Box sx={{ flex: 1, textAlign: "center" }}>
          <Typography sx={{ fontWeight: 600 }} aria-live="polite">
            Step {step.n} of {steps.length}
          </Typography>
          {current !== undefined && step.n !== current && (
            <Button size="small" onClick={() => setIndex(current - 1)}>
              Go to step {current}
            </Button>
          )}
        </Box>
        <Button endIcon={<NavigateNextIcon />} disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>
          Next
        </Button>
      </Stack>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1 }}>
          <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
            {step.title}
          </Typography>
          {current === step.n && <Chip color="primary" icon={<PhoneIphoneIcon />} label="You're here" />}
          {current !== undefined && step.n < current && <Chip color="success" variant="outlined" icon={<CheckIcon />} label="Done" />}
          <Chip
            icon={step.plug === "plugged" ? <PowerIcon /> : <PowerOffIcon />}
            color={step.plug === "plugged" ? "warning" : "default"}
            variant="outlined"
            label={step.plug === "plugged" ? "USB plugged in" : "USB unplugged"}
          />
        </Stack>
        {liveStep?.svgUrl ? (
          // Inline so each wire can be tapped to change its colour (drawn with the builder's colours).
          <Box
            onClick={(event) => {
              const wire = (event.target as Element).closest("[data-jumper]");
              const id = wire?.getAttribute("data-jumper");
              const net = wire?.getAttribute("data-net");
              if (id && net) openPicker({ jumper: id, net }, { top: event.clientY, left: event.clientX });
            }}
            sx={{ bgcolor: "canvas.main", borderRadius: 1, "& [data-jumper]": { cursor: "pointer" } }}
          >
            <SvgArtifact url={liveStep.svgUrl} label={`Breadboard for step ${step.n}: ${step.title}. Tap a wire to change its colour.`} sx={{ "& svg": { maxHeight: "44vh" } }} />
          </Box>
        ) : image ? (
          // Breadboard drawings are dark canvases in every theme.
          <Box
            component="img"
            src={image}
            alt={`Breadboard for step ${step.n}: ${step.title}`}
            sx={{ display: "block", width: "100%", maxHeight: "44vh", objectFit: "contain", bgcolor: "canvas.main", borderRadius: 1 }}
          />
        ) : (
          <Alert severity="info">No picture for this step.</Alert>
        )}
        <WireLegend wires={wires} />
        <Typography sx={{ mt: 1.5 }}>{liveStep?.text ?? step.text}</Typography>
        <StepWireChips jumpers={step.adds.jumpers} layout={liveBuild?.layout} wires={wires} onEdit={openPicker} />
        <RepeatChecklist key={step.n} step={step} />
        {setWireColor.isError && <Typography sx={{ color: "error.main" }}>Colour not saved: {setWireColor.error.message}</Typography>}
        {step.kind === "inventory" ? (
          <GatherParts revision={revision} inventory={inventory} />
        ) : (
          step.callouts.length > 0 && (
            <List dense disablePadding sx={{ mt: 1 }}>
              {step.callouts.map((c, i) => (
                <ListItem key={`${c}-${i}`} disableGutters>
                  <ListItemText primary={c} />
                </ListItem>
              ))}
            </List>
          )
        )}
        {step.checkpoint && (
          <>
            <Alert severity="info" sx={{ mt: 1 }}>
              Checkpoint: {step.checkpoint.text}
            </Alert>
            <CheckpointChecklist checks={checkpointChecks} onRun={runCheckpointChecks} />
          </>
        )}
        {canMark && (
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
            <Button
              variant="contained"
              startIcon={<CheckIcon />}
              disabled={didThis.isPending || !checksPassed}
              onClick={() => didThis.mutate(step.n)}
            >
              Done
            </Button>
            {step.checkpoint && (
              <Button variant="text" disabled={didThis.isPending} onClick={() => didThis.mutate(step.n)}>
                Skip checks and continue
              </Button>
            )}
            {didThis.isError && <Typography sx={{ color: "error.main" }}>Didn't save: {didThis.error.message}</Typography>}
          </Stack>
        )}
      </Paper>
      <WireColorPicker anchor={picker?.anchor ?? null} target={picker?.target ?? null} wires={wires} revision={revision.n} onClose={() => setPicker(null)} onPick={(request) => setWireColor.mutate(request)} />
      {released && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <PhoneQr missionId={missionId} />
        </Paper>
      )}
    </Stack>
  );
}
