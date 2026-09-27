import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BuildState, PhotoCheckResult } from "@vibread/core";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MobileStepper from "@mui/material/MobileStepper";
import Paper from "@mui/material/Paper";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import AddHomeOutlined from "@mui/icons-material/AddHomeOutlined";
import CameraAltOutlined from "@mui/icons-material/CameraAltOutlined";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import Close from "@mui/icons-material/Close";
import CloudOffOutlined from "@mui/icons-material/CloudOffOutlined";
import ErrorOutlined from "@mui/icons-material/ErrorOutlined";
import FactCheckOutlined from "@mui/icons-material/FactCheckOutlined";
import HelpOutlineOutlined from "@mui/icons-material/HelpOutlineOutlined";
import ImageNotSupportedOutlined from "@mui/icons-material/ImageNotSupportedOutlined";
import ReplayOutlined from "@mui/icons-material/ReplayOutlined";
import VisibilityOutlined from "@mui/icons-material/VisibilityOutlined";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import Usb from "@mui/icons-material/Usb";
import UsbOff from "@mui/icons-material/UsbOff";
import ZoomIn from "@mui/icons-material/ZoomIn";
import ZoomOut from "@mui/icons-material/ZoomOut";
import WifiOff from "@mui/icons-material/WifiOff";
import { useNavigate, useParams } from "react-router";
import { StepWireChips, WireColorPicker, WireLegend, useWireColor, type WireTarget } from "../workspace/WireColors.js";
import { checkpointChecksForRevision, checkpointChecksPass, checkpointStatusText, describeCheckpointChecks, isFullSelfTestStep, type CheckpointCheck } from "./checkpointChecks.js";
import { RepeatChecklist } from "./RepeatChecklist.js";
import { plugInstruction } from "./plugBanner.js";
import { scrollForCentre, viewCentre, type ViewCentre } from "./zoomScroll.js";
import {
  BuildApiError,
  createInventoryScan,
  fetchBuildState,
  fetchPhoneMissions,
  revisionQueryOptions,
  postBuildStep,
  postPhotoCheck,
  type PhoneMission,
} from "./api.js";

type BuildStep = BuildState["steps"][number] & { focusImageUrl?: string };
type ImageView = "focused" | "whole";
type PhotoVariables = { step: number; file: File };
type RecordedPhoto = NonNullable<PhotoCheckResult["recordedExample"]>;

const BUILD_QUERY_KEY = "mission-build";
const POLL_INTERVAL_MS = 1_500;
const STALE_AFTER_MS = 5_000;
const PWA_TIP_STORAGE_KEY = "vibread:pwa-install-tip-dismissed";

function isIosSafariBrowser(): boolean {
  const userAgent = navigator.userAgent;
  const iosDevice =
    /iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA/i.test(userAgent);
  return iosDevice && !otherIosBrowser && /Safari/i.test(userAgent);
}

function shouldShowPwaTip(): boolean {
  if (!isIosSafariBrowser()) return false;
  const standalone =
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (standalone) return false;
  try {
    return window.localStorage.getItem(PWA_TIP_STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

function buildQueryKey(missionId: string): readonly [string, string] {
  return [BUILD_QUERY_KEY, missionId];
}

function errorMessage(error: unknown): string {
  if (error instanceof BuildApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Please try again in a moment.";
}
function isUnauthorized(error: unknown): boolean {
  return error instanceof BuildApiError && (error.status === 401 || error.code === "UNAUTHORIZED");
}

function isClientError(error: unknown): boolean {
  return error instanceof BuildApiError && error.status >= 400 && error.status < 500;
}

function ageLabel(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  return `${seconds}s ago`;
}

function currentStepIndex(steps: BuildStep[], current: number): number {
  const exact = steps.findIndex((step) => step.n === current);
  if (exact >= 0) return exact;
  return Math.min(Math.max(current - 1, 0), Math.max(steps.length - 1, 0));
}

function statusDetails(status: PhotoCheckResult["answers"][number]["status"]): {
  label: string;
  color: "success" | "error" | "warning" | "default";
  icon: typeof CheckCircleOutlined;
} {
  switch (status) {
    case "correct":
      return { label: "Correct", color: "success", icon: CheckCircleOutlined };
    case "wrong":
      return { label: "Check this", color: "error", icon: ErrorOutlined };
    case "missing":
      return { label: "Missing", color: "warning", icon: ErrorOutlined };
    case "unknown":
      return { label: "Not sure", color: "default", icon: HelpOutlineOutlined };
  }
}

function PlugBanner({ plug, previous, reducedMotion }: { plug: BuildStep["plug"]; previous: BuildStep["plug"] | undefined; reducedMotion: boolean }) {
  const instruction = plugInstruction(plug, previous);
  const Icon = instruction.plugged ? Usb : UsbOff;
  const tone = instruction.plugged ? "success" : "warning";
  return (
    <Chip
      component="section"
      aria-label={instruction.action}
      icon={<Icon aria-hidden="true" />}
      label={instruction.action}
      // A change of cable state is the one thing a builder must not miss: filled, not outlined.
      variant={instruction.change ? "filled" : "outlined"}
      color={instruction.change ? tone : "default"}
      sx={{
        alignSelf: "flex-start",
        height: "auto",
        minHeight: 40,
        maxWidth: "100%",
        fontWeight: instruction.change ? 800 : 500,
        ...(instruction.change
          ? {}
          : { color: `${tone}.main`, borderColor: `${tone}.main`, bgcolor: "background.paper", "& .MuiChip-icon": { color: `${tone}.main` } }),
        transition: reducedMotion ? "none" : "border-color 180ms ease",
        "& .MuiChip-label": { whiteSpace: "normal", py: 0.75 },
      }}
    />
  );
}

const ZOOM_LEVELS = [1, 2, 3, 4] as const;

/** Full-screen picture of a step: zoom buttons widen the image and the dialog scrolls both ways (pinch still works). */
function ZoomedStepImage({ url, title, label, open, onClose }: { url: string; title: string; label: string; open: boolean; onClose: () => void }) {
  const [zoom, setZoom] = useState(2);
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Opens on the middle of the picture; each zoom keeps whatever spot was in the middle of the screen.
  const centre = useRef<ViewCentre>({ x: 0.5, y: 0.5 });
  const recentre = () => {
    const box = scroller.current;
    if (!box) return;
    const { left, top } = scrollForCentre(centre.current, box);
    box.scrollTo({ left, top });
  };
  const changeZoom = (next: number) => {
    if (scroller.current) centre.current = viewCentre(scroller.current);
    setZoom(next);
  };
  useLayoutEffect(recentre, [zoom, open]);
  return (
    <Dialog fullScreen open={open} onClose={onClose} aria-label={label}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 0.5, px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, fontWeight: 800 }} noWrap>
          {title}
        </Typography>
        <IconButton aria-label="Zoom out" disabled={zoomIndex <= 0} onClick={() => changeZoom(ZOOM_LEVELS[zoomIndex - 1])} sx={{ width: 48, height: 48 }}>
          <ZoomOut />
        </IconButton>
        <Typography variant="body2" aria-live="polite" sx={{ minWidth: 28, textAlign: "center" }}>
          {zoom}×
        </Typography>
        <IconButton aria-label="Zoom in" disabled={zoomIndex >= ZOOM_LEVELS.length - 1} onClick={() => changeZoom(ZOOM_LEVELS[zoomIndex + 1])} sx={{ width: 48, height: 48 }}>
          <ZoomIn />
        </IconButton>
        <IconButton aria-label="Close picture" onClick={onClose} sx={{ width: 48, height: 48 }}>
          <Close />
        </IconButton>
      </Stack>
      <Box ref={scroller} sx={{ flex: 1, overflow: "auto", bgcolor: "canvas.main", display: "flex", alignItems: zoom === 1 ? "center" : "flex-start" }}>
        <Box component="img" src={url} alt={label} onLoad={recentre} sx={{ display: "block", width: `${zoom * 100}%`, maxWidth: "none", height: "auto", flexShrink: 0 }} />
      </Box>
    </Dialog>
  );
}
function preloadImage(url?: string): void {
  if (!url) return;
  const image = new window.Image();
  image.src = url;
  void image.decode().catch(() => undefined);
}
function imageFallbackAspect(step: BuildStep, view: ImageView): string {
  return view === "whole" || !step.focusImageUrl ? "10 / 9" : "40 / 49";
}



function StepImage({ step, reducedMotion }: { step: BuildStep; reducedMotion: boolean }) {
  const [imageView, setImageView] = useState<ImageView>("focused");
  const [aspectRatio, setAspectRatio] = useState(() => imageFallbackAspect(step, "focused"));
  const [displayedUrl, setDisplayedUrl] = useState<string | undefined>(() => step.focusImageUrl ?? step.imageUrl);
  const [loading, setLoading] = useState(Boolean(step.focusImageUrl ?? step.imageUrl));
  const [failed, setFailed] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const loadId = useRef(0);
  const hasWholeBoard = Boolean(step.focusImageUrl && step.imageUrl);
  const showWholeBoard = imageView === "whole";

  const requestImage = (url?: string) => {
    const requestId = ++loadId.current;
    setLoading(Boolean(url));
    setFailed(false);
    if (!url) {
      setDisplayedUrl(undefined);
      setLoading(false);
      return;
    }
    const image = new window.Image();
    image.decoding = "async";
    image.src = url;
    void image.decode().then(
      () => {
        if (requestId === loadId.current) {
          setDisplayedUrl(url);
          setLoading(false);
        }
      },
      () => {
        if (requestId !== loadId.current) return;
        if (step.imageUrl && url !== step.imageUrl) {
          setImageView("whole");
          requestImage(step.imageUrl);
        } else {
          setFailed(true);
          setLoading(false);
        }
      },
    );
  };

  useEffect(() => {
    setImageView("focused");
    setAspectRatio(imageFallbackAspect(step, "focused"));
    requestImage(step.focusImageUrl ?? step.imageUrl);
    return () => {
      loadId.current += 1;
    };
  }, [step.n, step.focusImageUrl, step.imageUrl]);

  const handleImageError = () => {
    if (!showWholeBoard && hasWholeBoard) {
      setImageView("whole");
      requestImage(step.imageUrl);
      return;
    }
    setFailed(true);
    setLoading(false);
  };

  const handleImageViewChange = (_event: MouseEvent<HTMLElement>, next: ImageView | null) => {
    if (next) {
      setImageView(next);
      setAspectRatio(imageFallbackAspect(step, next));
      requestImage(next === "whole" ? step.imageUrl : step.focusImageUrl ?? step.imageUrl);
    }
  };

  const imageLabel = `${showWholeBoard ? "Whole board" : "Focused step"} illustration for step ${step.n}: ${step.title}`;
  const canZoom = Boolean(displayedUrl && !failed && !loading);
  return (
    <Box>
      <Box
        component={canZoom ? "button" : "div"}
        type={canZoom ? "button" : undefined}
        onClick={canZoom ? () => setZoomOpen(true) : undefined}
        aria-label={canZoom ? `Enlarge picture — ${imageLabel}` : imageLabel}
        role={canZoom ? undefined : "img"}
        aria-busy={loading}
        sx={{
          position: "relative",
          display: "block",
          width: "100%",
          aspectRatio,
          overflow: "hidden",
          bgcolor: "canvas.main",
          border: 0,
          p: 0,
          cursor: canZoom ? "zoom-in" : "default",
          "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: -3 },
        }}
      >
        <Skeleton
          variant="rectangular"
          animation={reducedMotion ? false : "pulse"}
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", bgcolor: "action.hover" }}
        />
        {displayedUrl && !failed && (
          <CardMedia
            component="img"
            image={displayedUrl}
            alt={imageLabel}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspectRatio(`${image.naturalWidth} / ${image.naturalHeight}`);
            }}
            onError={handleImageError}
            sx={{ position: "absolute", inset: 0, zIndex: 1, width: "100%", height: "100%", objectFit: "contain" }}
          />
        )}
        {(!displayedUrl || failed) && !loading && (
          <Stack
            spacing={0.75}
            sx={{ position: "absolute", inset: 0, zIndex: 2, alignItems: "center", justifyContent: "center", color: "text.secondary" }}
          >
            <ImageNotSupportedOutlined aria-hidden="true" />
            <Typography variant="caption">Step illustration unavailable</Typography>
          </Stack>
        )}
        {canZoom && (
          <Box
            aria-hidden="true"
            sx={{ position: "absolute", right: 8, bottom: 8, zIndex: 3, display: "flex", p: 0.5, borderRadius: "50%", bgcolor: "background.paper", color: "text.primary", boxShadow: 2 }}
          >
            <ZoomIn fontSize="small" />
          </Box>
        )}
      </Box>
      {displayedUrl && <ZoomedStepImage key={displayedUrl} url={displayedUrl} title={`Step ${step.n}: ${step.title}`} label={imageLabel} open={zoomOpen} onClose={() => setZoomOpen(false)} />}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, pt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {canZoom ? "Tap to zoom" : ""}
        </Typography>
        {hasWholeBoard && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={imageView}
            onChange={handleImageViewChange}
            aria-label="Step image view"
          >
            <ToggleButton value="focused" sx={{ minHeight: 44 }}>
              Focused
            </ToggleButton>
            <ToggleButton value="whole" sx={{ minHeight: 44 }}>
              Whole board
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>
    </Box>
  );
}
function isBuildComplete(build: BuildState): boolean {
  const lastStep = build.steps[build.steps.length - 1];
  const headline = build.headline?.trim().toLowerCase() ?? "";
  return (
    lastStep !== undefined &&
    (headline === `step ${lastStep.n} done` ||
      headline.startsWith("build finished") ||
      headline.startsWith(`all ${build.steps.length} steps done`))
  );
}

function FinishedBuild({ total, onReview }: { total: number; onReview: () => void }) {
  return (
    <Paper
      component="section"
      aria-label="Build complete"
      variant="outlined"
      sx={{ p: 2.5, borderRadius: 3, borderWidth: 2, borderColor: "success.main", bgcolor: "action.hover" }}
    >
      <Stack spacing={1.25} sx={{ alignItems: "flex-start" }}>
        <CheckCircleOutlined color="success" sx={{ fontSize: 38 }} aria-hidden="true" />
        <Typography component="h2" variant="h5" sx={{ fontWeight: 800 }}>
          All {total} steps done — now test it at the bench on your laptop
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Open Bench on your laptop to run the safe checks.
        </Typography>
        <Button
          type="button"
          variant="outlined"
          fullWidth
          onClick={onReview}
          sx={{ minHeight: 52, width: "100%", borderRadius: 2.5, fontWeight: 800 }}
        >
          Review steps
        </Button>
      </Stack>
    </Paper>
  );
}


/** Wire colours on the phone: the legend plus a chip per wire the step adds; tapping a chip opens the picker. */
function StepWireColors({ missionId, build, step }: { missionId: string; build: BuildState; step: BuildStep }) {
  const setWireColor = useWireColor(missionId, buildQueryKey(missionId));
  const [picker, setPicker] = useState<{ target: WireTarget; anchor: { top: number; left: number } } | null>(null);
  if (!build.wires || build.revision === undefined) return null;
  return (
    <Box sx={{ mt: 1.5 }}>
      <WireLegend wires={build.wires} />
      <StepWireChips jumpers={step.adds.jumpers} layout={build.layout} wires={build.wires} onEdit={(target, anchor) => setPicker({ target, anchor })} />
      {setWireColor.isError && <Typography sx={{ color: "error.main", mt: 0.5 }}>Colour not saved: {errorMessage(setWireColor.error)}</Typography>}
      <WireColorPicker anchor={picker?.anchor ?? null} target={picker?.target ?? null} wires={build.wires} revision={build.revision} onClose={() => setPicker(null)} onPick={(request) => setWireColor.mutate(request)} />
    </Box>
  );
}

function CheckpointCheckList({ checks }: { checks: CheckpointCheck[] }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
        Run on the laptop
      </Typography>
      <List dense disablePadding sx={{ mt: 0.5 }}>
        {checks.map((check) => {
          const Icon = check.status === "pass" ? CheckCircleOutlined : check.status === "fail" ? ErrorOutlined : check.status === "manual" ? VisibilityOutlined : check.status === "incomplete" ? ReplayOutlined : FactCheckOutlined;
          const status = checkpointStatusText(check.status);
          return (
            <ListItem key={check.id} disableGutters>
              <ListItemIcon sx={{ minWidth: 32 }}>
                <Icon color={check.status === "pass" ? "success" : check.status === "fail" ? "error" : "disabled"} aria-hidden="true" />
              </ListItemIcon>
              <ListItemText primary={check.expected} secondary={check.diagnosis ? `${status} — ${check.diagnosis}` : status} />
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}

function StepCard({ step, total, reducedMotion, wires, checkpointChecks }: { step: BuildStep; total: number; reducedMotion: boolean; wires?: React.ReactNode; checkpointChecks?: CheckpointCheck[] }) {
  return (
    <Card
      component="article"
      sx={{
        overflow: "hidden",
        borderRadius: 3,
        border: "1px solid",
        borderColor: "divider",
        transition: reducedMotion ? "none" : "box-shadow 180ms ease",
      }}
    >
      <StepImage step={step} reducedMotion={reducedMotion} />
      <CardContent sx={{ p: { xs: 2, sm: 2.5 }, "&:last-child": { pb: { xs: 2, sm: 2.5 } } }}>
        <Typography variant="overline" color="primary.main" sx={{ fontWeight: 800, letterSpacing: "0.1em" }}>
          Step {step.n} of {total}
        </Typography>
        <Typography component="h2" variant="h5" sx={{ mt: 0.25, mb: 1.2, fontWeight: 800 }}>
          {step.title}
        </Typography>
        <Typography
          component="p"
          variant="body1"
          sx={{ whiteSpace: "pre-wrap", lineHeight: 1.65, overflowWrap: "anywhere" }}
        >
          {step.text}
        </Typography>
        {wires}
        <RepeatChecklist key={step.n} step={step} />

        {step.holes.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 800 }}>
              Exact holes
            </Typography>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.75 }}>
              {step.holes.map((hole) => (
                <Chip key={hole} label={hole} size="small" variant="outlined" sx={{ minHeight: 32 }} />
              ))}
            </Stack>
          </Box>
        )}

        {step.callouts.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 800 }}>
              Parts for this step
            </Typography>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.75 }}>
              {step.callouts.map((callout, index) => (
                <Chip
                  key={`${callout}-${index}`}
                  label={callout}
                  variant="outlined"
                  sx={{
                    height: "auto",
                    minHeight: 36,
                    maxWidth: "100%",
                    "& .MuiChip-label": { whiteSpace: "normal", py: 0.75 },
                  }}
                />
              ))}
            </Stack>
          </Box>
        )}

        {step.checkpoint && (
          <Paper
            component="section"
            aria-label="Checkpoint"
            variant="outlined"
            sx={{ mt: 2, p: 1.5, borderRadius: 2.5, bgcolor: "action.hover" }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <FactCheckOutlined aria-hidden="true" color="info" sx={{ mt: 0.15 }} />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                  Checkpoint
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.35, whiteSpace: "pre-wrap" }}>
                  {step.checkpoint.text}
                </Typography>
              </Box>
            </Stack>
            <CheckpointCheckList checks={checkpointChecks ?? []} />
          </Paper>
        )}
      </CardContent>
    </Card>
  );
}

function PhotoAnswers({ answers, prefix = "" }: { answers: PhotoCheckResult["answers"]; prefix?: string }) {
  return (
    <Stack spacing={1}>
      {answers.map((answer) => {
        const details = statusDetails(answer.status);
        const StatusIcon = details.icon;
        return (
          <Paper key={`${prefix}${answer.part}`} variant="outlined" sx={{ p: 1.25, borderRadius: 2 }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
              <StatusIcon aria-hidden="true" color={details.color === "default" ? undefined : details.color} sx={{ mt: 0.15 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                  {prefix}{answer.part}: {details.label}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.2, overflowWrap: "anywhere" }}>
                  {answer.note}
                </Typography>
              </Box>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

function RecordedPhotoResult({ example }: { example: RecordedPhoto }) {
  const design = example.design.replace(/\s+\(golden design\)$/i, "");
  return (
    <Stack component="section" aria-label="Recorded photo check example" spacing={1.25} sx={{ mt: 1.5 }}>
      <Alert severity="warning" icon={<CameraAltOutlined />}>
        <AlertTitle>Photo check needs Claude — here's what it looks like</AlertTitle>
        <Typography variant="body2">
          Your photo wasn't checked. Below is a recorded Claude example, not a verdict on your photo.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          Connect Claude on the laptop (Settings)
        </Typography>
      </Alert>
      <Chip label={example.label} variant="outlined" sx={{ alignSelf: "flex-start", minHeight: 36 }} />
      <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
        Example: step {example.step} of the {design}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {example.stepTitle}
      </Typography>
      <CardMedia
        component="img"
        image={example.imageUrl}
        alt={`Recorded example image for step ${example.step}: ${example.stepTitle}`}
        sx={{ width: "100%", maxHeight: 270, objectFit: "contain", borderRadius: 2, bgcolor: "canvas.main" }}
      />
      {example.photoWasRender && (
        <Typography variant="caption" color="text.secondary">
          No real photo was used: Claude checked ViBread's drawing of this step in place of a phone photo.
        </Typography>
      )}
      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
        Example answers
      </Typography>
      <PhotoAnswers answers={example.answers} prefix="Example · " />
    </Stack>
  );
}

function PhotoResult({ result }: { result: PhotoCheckResult }) {
  if (result.recordedExample) {
    return <RecordedPhotoResult example={result.recordedExample} />;
  }

  return (
    <Stack component="section" aria-label="Photo check result" spacing={1.25} sx={{ mt: 1.5 }}>
      <Alert severity="info" icon={<CameraAltOutlined />}>
        <AlertTitle>Advisory photo check</AlertTitle>
        {result.summary} This never blocks your build and does not override the board check.
      </Alert>
      <PhotoAnswers answers={result.answers} />
      <Typography variant="caption" color="text.secondary">
        Model: {result.model}
      </Typography>
    </Stack>
  );
}

function BuildChecklist({ missionId, build }: { missionId: string; build: BuildState }) {
  const queryClient = useQueryClient();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const steps = build.steps;
  const initialStep = useMemo(() => currentStepIndex(steps, build.current), [build.current, steps]);
  const [activeStep, setActiveStep] = useState(initialStep);
  const [finished, setFinished] = useState(() => isBuildComplete(build));
  const [reviewing, setReviewing] = useState(false);
  const [photoResult, setPhotoResult] = useState<PhotoCheckResult | null>(null);
  const [photoStep, setPhotoStep] = useState<number | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoResultRef = useRef<HTMLDivElement>(null);
  const safeActiveStep = Math.min(Math.max(activeStep, 0), Math.max(steps.length - 1, 0));
  const lastStepNumber = steps[steps.length - 1]?.n;
  const currentStepNumber = steps[safeActiveStep]?.n;
  // `steps` may be empty (the page says so below); `step` is only used past that check.
  const step: BuildStep | undefined = steps[safeActiveStep];
  // The checks run on the laptop and land on this revision: while a checkpoint step is on screen, poll like the build
  // state does, so the phone unlocks (or shows a new failure) within a couple of seconds of the laptop's run.
  const revisionQuery = useQuery(revisionQueryOptions(missionId, build.revision, !finished && Boolean(step?.checkpoint)));
  const fullSelfTest = step !== undefined && isFullSelfTestStep(step);
  const checkpointChecks = step?.checkpoint
    ? revisionQuery.data
      ? checkpointChecksForRevision({
          circuit: revisionQuery.data.circuit,
          revisionHash: revisionQuery.data.hash,
          tests: step.checkpoint.tests,
          plan: revisionQuery.data.results.selftest,
          runs: revisionQuery.data.results.bench,
          fullSelfTest,
          step: step.n,
          layout: revisionQuery.data.results.layout,
        })
      : describeCheckpointChecks({ tests: step.checkpoint.tests, fullSelfTest })
    : [];
  const checkpointPassed = !step?.checkpoint || checkpointChecksPass(checkpointChecks);
  useEffect(() => {
    for (const index of [safeActiveStep - 1, safeActiveStep, safeActiveStep + 1]) {
      const candidate = steps[index];
      if (!candidate) continue;
      preloadImage(candidate.focusImageUrl);
      preloadImage(candidate.imageUrl);
    }
  }, [safeActiveStep, steps]);

  useEffect(() => {
    setActiveStep(initialStep);
  }, [initialStep]);

  useEffect(() => {
    setPhotoResult(null);
    setPhotoStep(null);
    setPhotoError(null);
  }, [safeActiveStep]);

  useEffect(() => {
    if (!reviewing) setFinished(isBuildComplete(build));
  }, [build.headline, build.revision, build.steps.length, reviewing]);

  useEffect(() => {
    if (photoResult && photoStep === currentStepNumber) {
      photoResultRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    }
  }, [currentStepNumber, photoResult, photoStep, reducedMotion]);

  const stepMutation = useMutation({
    mutationFn: (n: number) => postBuildStep(missionId, n),
    onSuccess: (nextBuild, n) => {
      queryClient.setQueryData(buildQueryKey(missionId), nextBuild);
      if (lastStepNumber !== undefined && n >= lastStepNumber) setFinished(true);
    },
  });
  const photoMutation = useMutation<PhotoCheckResult, unknown, PhotoVariables>({
    mutationFn: ({ step, file }) => postPhotoCheck(missionId, step, file),
    onSuccess: (result, variables) => {
      setPhotoResult(result);
      setPhotoStep(variables.step);
      setPhotoError(null);
    },
    onError: (error) => {
      setPhotoResult(null);
      setPhotoError(errorMessage(error));
    },
  });

  if (steps.length === 0) {
    return (
      <Alert severity="info" icon={<FactCheckOutlined />}>
        <AlertTitle>Build steps are getting ready</AlertTitle>
        This mission does not have an assembly checklist yet. Keep this page open while Mission Control prepares it.
      </Alert>
    );
  }

  if (finished) {
    return (
      <FinishedBuild
        total={steps.length}
        onReview={() => {
          setReviewing(true);
          setActiveStep(0);
          setFinished(false);
        }}
      />
    );
  }

  const handlePhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError(null);
    setPhotoResult(null);
    photoMutation.mutate({ step: step.n, file });
  };
  const handleStepDone = () => {
    if (stepMutation.isPending) return;
    const previousStep = safeActiveStep;
    const nextStep = Math.min(previousStep + 1, steps.length - 1);
    if (nextStep !== previousStep) setActiveStep(nextStep);
    stepMutation.mutate(step.n, {
      onError: () => setActiveStep(previousStep),
    });
  };


  return (
    <Stack spacing={1.5}>
      <PlugBanner plug={step.plug} previous={steps[safeActiveStep - 1]?.plug} reducedMotion={reducedMotion} />
      <MobileStepper
        variant="progress"
        steps={steps.length}
        position="static"
        activeStep={safeActiveStep}
        aria-label="Build step navigation"
        sx={{
          p: 0,
          minHeight: 52,
          bgcolor: "transparent",
        }}
        backButton={
          <Button
            type="button"
            size="small"
            onClick={() => setActiveStep((index) => Math.max(index - 1, 0))}
            disabled={stepMutation.isPending || safeActiveStep === 0}
            startIcon={<KeyboardArrowLeft />}
            sx={{ minWidth: 84, minHeight: 44 }}
          >
            Back
          </Button>
        }
        nextButton={
          <Button
            type="button"
            size="small"
            onClick={() => setActiveStep((index) => Math.min(index + 1, steps.length - 1))}
            disabled={stepMutation.isPending || safeActiveStep === steps.length - 1}
            endIcon={<KeyboardArrowRight />}
            sx={{ minWidth: 84, minHeight: 44 }}
          >
            Next
          </Button>
        }
      />

      <StepCard step={step} total={steps.length} reducedMotion={reducedMotion} checkpointChecks={checkpointChecks} wires={<StepWireColors missionId={missionId} build={build} step={step} />} />

      <Button
        type="button"
        variant="contained"
        size="large"
        fullWidth
        onClick={handleStepDone}
        disabled={stepMutation.isPending || !checkpointPassed}
        aria-busy={stepMutation.isPending}
        startIcon={stepMutation.isPending ? <CircularProgress color="inherit" size={20} /> : undefined}
        sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
      >
        {stepMutation.isPending ? "Saving…" : "Done"}
      </Button>
      {step.checkpoint && !checkpointPassed && !stepMutation.isPending && (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
          Done unlocks when the checks above pass — run them from Bench on your laptop.
        </Typography>
      )}
      {stepMutation.error && (
        <Alert severity="error" icon={<CloudOffOutlined />}>
          <AlertTitle>Could not save this step</AlertTitle>
          {errorMessage(stepMutation.error)}
        </Alert>
      )}
      {step.checkpoint && (
        <Button
          type="button"
          variant="text"
          fullWidth
          disabled={stepMutation.isPending}
          onClick={() => stepMutation.mutate(step.n)}
          sx={{ minHeight: 44 }}
        >
          Skip checks and continue
        </Button>
      )}

      <Divider sx={{ my: 0.5 }} />
      <Button
        component="label"
        type="button"
        variant="outlined"
        size="large"
        fullWidth
        disabled={photoMutation.isPending}
        aria-busy={photoMutation.isPending}
        startIcon={photoMutation.isPending ? <CircularProgress size={20} /> : <CameraAltOutlined />}
        sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
      >
        {photoMutation.isPending ? "Checking photo…" : "Check with camera"}
        <input
          hidden
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhotoChange}
        />
      </Button>
      {photoResult && photoStep === step.n && (
        <Box ref={photoResultRef}>
          <PhotoResult result={photoResult} />
        </Box>
      )}
      {photoError && (
        <Alert severity="warning" icon={<CloudOffOutlined />}>
          <AlertTitle>Photo check unavailable</AlertTitle>
          {photoError} You can continue building; photo checks are advisory.
        </Alert>
      )}
    </Stack>
  );
}

function PhoneBuildChooser({
  missions,
  loading,
  error,
  onSelect,
}: {
  missions?: PhoneMission[];
  loading: boolean;
  error: unknown;
  onSelect: (missionId: string) => void;
}) {
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const scanMutation = useMutation({
    mutationFn: () => createInventoryScan(),
    onSuccess: ({ id }) => navigate(`/scan/${encodeURIComponent(id)}`),
  });
  const canOpenBuild = !loading && !error && Boolean(missions?.length);
  const continueBuilding = () => {
    if (missions?.length === 1) onSelect(missions[0].id);
    else setPickerOpen(true);
  };
  return (
    <Box
      component="main"
      sx={{ minHeight: "100svh", width: "100%", px: { xs: 1.5, sm: 3 }, py: { xs: 2, sm: 3 }, display: "flex", justifyContent: "center" }}
    >
      <Box sx={{ width: "100%", maxWidth: 520 }}>
        <Stack spacing={1.5}>
          <Typography variant="overline" color="primary.main" sx={{ fontWeight: 800, letterSpacing: "0.12em" }}>
            Mission Control · Build Mode
          </Typography>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 900 }}>
            Choose a build
          </Typography>
          <Stack spacing={1}>
            <Button
              type="button"
              variant="contained"
              onClick={continueBuilding}
              disabled={!canOpenBuild}
              sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
            >
              Continue building
            </Button>
            <Button
              type="button"
              variant="outlined"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              aria-busy={scanMutation.isPending}
              sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
            >
              {scanMutation.isPending ? "Starting scan…" : "Scan parts"}
            </Button>
            <Button
              type="button"
              variant="outlined"
              onClick={continueBuilding}
              disabled={!canOpenBuild}
              sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
            >
              Check this step
            </Button>
          </Stack>
          {scanMutation.error && (
            <Alert severity="error" icon={<CloudOffOutlined />}>
              <AlertTitle>Scan could not start</AlertTitle>
              {errorMessage(scanMutation.error)}
            </Alert>
          )}
          {loading && (
            <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
              <Stack spacing={1.25} sx={{ alignItems: "center" }}>
                <CircularProgress aria-label="Loading available builds" />
                <Typography color="text.secondary">Finding released builds…</Typography>
              </Stack>
            </Paper>
          )}
          {!loading && error !== undefined && error !== null && (
            <Alert severity="error" icon={<CloudOffOutlined />}>
              <AlertTitle>Builds unavailable</AlertTitle>
              {errorMessage(error)}
            </Alert>
          )}
          {!loading && !error && missions?.length === 0 && (
            <Alert severity="info" icon={<FactCheckOutlined />}>
              Nothing to build yet — press GO for build on the laptop.
            </Alert>
          )}
          {!loading && !error && pickerOpen && missions && missions.length > 1 && (
            <Stack component="ul" spacing={1.25} sx={{ p: 0, m: 0, listStyle: "none" }}>
              {missions.map((mission) => (
                <Paper component="li" key={mission.id} variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                  <Stack spacing={1.25}>
                    <Typography component="h2" variant="h6" sx={{ fontWeight: 800 }}>
                      {mission.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Step {Math.max(1, mission.currentStep)} is ready
                    </Typography>
                    <Button
                      type="button"
                      variant="contained"
                      onClick={() => onSelect(mission.id)}
                      sx={{ minHeight: 48, borderRadius: 2.5, fontWeight: 800 }}
                    >
                      Open build
                    </Button>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </Box>
  );
}

export interface BuildModePageProps {
  missionId?: string;
}

export default function BuildModePage({ missionId: missionIdProp }: BuildModePageProps = {}) {
  const { missionId: routeMissionId } = useParams<{ missionId: string }>();
  const missionId = missionIdProp ?? routeMissionId ?? "";
  // Keyed by mission: going from /b/A to /b/B starts fresh instead of carrying A's current step and finished state over.
  return <BuildModeScreen key={missionId} missionId={missionId} />;
}

function BuildModeScreen({ missionId }: { missionId: string }) {
  const navigate = useNavigate();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const [now, setNow] = useState(() => Date.now());
  const [showPwaTip, setShowPwaTip] = useState(false);
  const query = useQuery({
    queryKey: buildQueryKey(missionId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchBuildState(missionId, signal),
    enabled: missionId.length > 0,
    refetchInterval: (currentQuery) => (isClientError(currentQuery.state.error) ? false : POLL_INTERVAL_MS),
    refetchIntervalInBackground: true,
    retry: false,
  });
  // Released builds. Also fetched for a direct /b/<id> link: a mission without GO for build isn't in it, and its steps
  // (the latest, unreviewed design) get a warning instead of looking like the build target.
  const phoneMissionsQuery = useQuery({
    queryKey: ["phone-builds"],
    queryFn: ({ signal }) => fetchPhoneMissions(signal),
    refetchInterval: missionId ? 10_000 : false,
    retry: 1,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setShowPwaTip(shouldShowPwaTip());
  }, []);
  useEffect(() => {
    const onlyMission = phoneMissionsQuery.data?.length === 1 ? phoneMissionsQuery.data[0] : undefined;
    if (!missionId && onlyMission) {
      navigate(`/b/${encodeURIComponent(onlyMission.id)}`, { replace: true });
    }
  }, [missionId, navigate, phoneMissionsQuery.data]);

  const dismissPwaTip = () => {
    try {
      window.localStorage.setItem(PWA_TIP_STORAGE_KEY, "1");
    } catch {
      // Private browsing can deny storage; dismiss for this view regardless.
    }
    setShowPwaTip(false);
  };
  if (isUnauthorized(query.error)) return null;

  if (!missionId && phoneMissionsQuery.data?.length === 1) return null;

  if (!missionId) {
    return (
      <PhoneBuildChooser
        missions={phoneMissionsQuery.data}
        loading={phoneMissionsQuery.isPending}
        error={phoneMissionsQuery.error}
        onSelect={(id) => navigate(`/b/${encodeURIComponent(id)}`)}
      />
    );
  }

  const build = query.data;
  const notReleased = Boolean(build && phoneMissionsQuery.data && !phoneMissionsQuery.data.some((mission) => mission.id === missionId));
  const stale = Boolean(build && query.dataUpdatedAt > 0 && now - query.dataUpdatedAt > STALE_AFTER_MS);
  // An unreleased preview gets the warning below instead of a "ready" chip.
  const headline = build?.headline?.trim() || (build && build.steps.length > 0 && !notReleased ? "Build checklist ready" : undefined);

  return (
    <Box
      component="main"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      sx={{
        minHeight: "100svh",
        width: "100%",
        px: { xs: 1.5, sm: 3 },
        py: { xs: 1.5, sm: 3 },
        display: "flex",
        justifyContent: "center",
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 520 }}>
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            sx={{ alignItems: { xs: "stretch", sm: "flex-start" }, justifyContent: "space-between" }}
          >
            <Box>
              <Typography variant="overline" color="primary.main" sx={{ fontWeight: 800, letterSpacing: "0.12em" }}>
                Mission Control · Build Mode
              </Typography>
              <Typography component="h1" variant="h4" sx={{ lineHeight: 1.1, fontWeight: 900 }}>
                Build your circuit
              </Typography>
            </Box>
          <Stack direction="row" sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
            {showPwaTip && (
              <Chip
                icon={<AddHomeOutlined />}
                label="Add to Home Screen · Share → Add to Home Screen"
                onDelete={dismissPwaTip}
                deleteIcon={<Close aria-label="Dismiss Add to Home Screen tip" />}
                variant="outlined"
                sx={{
                  minHeight: 40,
                  maxWidth: "100%",
                  "& .MuiChip-label": { whiteSpace: "normal", py: 0.75 },
                }}
              />
            )}
            {stale && (
              <Chip
                icon={<WifiOff />}
                label={`Connection stale · ${ageLabel(query.dataUpdatedAt, now)}`}
                color="warning"
                variant="outlined"
                sx={{ minHeight: 36 }}
              />
            )}
            {headline && (
              <Chip
                icon={stale ? <WifiOff /> : <FactCheckOutlined />}
                label={headline}
                color={stale ? "warning" : "info"}
                variant="outlined"
                role="status"
                sx={{ minHeight: 36, maxWidth: "100%", "& .MuiChip-label": { whiteSpace: "normal" } }}
              />
            )}
          </Stack>
          </Stack>

          {query.error && build && (
            <Alert severity="warning" icon={<CloudOffOutlined />}>
              <AlertTitle>Waiting for Mission Control</AlertTitle>
              {errorMessage(query.error)}
            </Alert>
          )}

          {notReleased && (
            <Alert severity="warning" icon={<FactCheckOutlined />}>
              <AlertTitle>Not released for building yet</AlertTitle>
              These steps are for the latest design, which can still change. Press GO for build on the laptop before you build.
            </Alert>
          )}

          {query.isPending && !build && (
            <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
              <Stack spacing={1.5} sx={{ alignItems: "center" }}>
                <CircularProgress aria-label="Loading build steps" />
                <Typography color="text.secondary">Loading your build steps…</Typography>
              </Stack>
            </Paper>
          )}

          {query.error && !build && (
            isClientError(query.error) ? (
              <Alert severity="warning" icon={<CloudOffOutlined />}>
                <AlertTitle>Build unavailable</AlertTitle>
                This build isn't on this computer any more — scan the QR code on the laptop again.
                <Link href="/b" underline="hover" sx={{ display: "block", mt: 1.25, width: "fit-content" }}>
                  Back to phone home
                </Link>
              </Alert>
            ) : (
              <Alert severity="error" icon={<CloudOffOutlined />}>
                <AlertTitle>Build steps unavailable</AlertTitle>
                {errorMessage(query.error)}
                <Button
                  type="button"
                  onClick={() => void query.refetch()}
                  variant="outlined"
                  sx={{ display: "block", mt: 1.5, minHeight: 46 }}
                >
                  Try again
                </Button>
              </Alert>
            )
          )}

          {build && <BuildChecklist missionId={missionId} build={build} />}
        </Stack>
      </Box>
    </Box>
  );
}
