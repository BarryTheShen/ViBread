import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BuildState, PhotoCheckResult } from "@vibread/core";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CardMedia,
  Chip,
  CircularProgress,
  Divider,
  Link,
  MobileStepper,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from "@mui/material";
import {
  CameraAltOutlined,
  CheckCircleOutlined,
  CloudOffOutlined,
  ErrorOutlined,
  FactCheckOutlined,
  HelpOutlineOutlined,
  ImageNotSupportedOutlined,
  KeyboardArrowLeft,
  KeyboardArrowRight,
  Usb,
  UsbOff,
  WifiOff,
} from "@mui/icons-material";
import { useParams } from "react-router";
import { BuildApiError, fetchBuildState, postBuildStep, postPhotoCheck } from "./api.js";

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

function PlugBanner({ plug, reducedMotion }: { plug: BuildStep["plug"]; reducedMotion: boolean }) {
  const plugged = plug === "plugged";
  const Icon = plugged ? Usb : UsbOff;
  return (
    <Paper
      component="section"
      aria-label={plugged ? "USB plugged in" : "USB unplugged"}
      variant="outlined"
      sx={{
        p: 1.75,
        borderRadius: 3,
        borderWidth: 2,
        borderColor: plugged ? "success.main" : "warning.main",
        bgcolor: plugged ? "rgba(62, 189, 126, 0.1)" : "rgba(244, 180, 0, 0.1)",
        transition: reducedMotion ? "none" : "border-color 180ms ease, background-color 180ms ease",
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <Icon
          aria-hidden="true"
          sx={{ fontSize: 34, color: plugged ? "success.main" : "warning.main", flexShrink: 0 }}
        />
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
            {plugged ? "USB plugged in" : "USB unplugged"}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>
            {plugged ? "Plug the USB cable in now" : "Keep the USB cable unplugged"}
          </Typography>
        </Box>
      </Stack>
    </Paper>
  );
}

function StepImage({ step }: { step: BuildStep }) {
  const [imageView, setImageView] = useState<ImageView>("focused");
  const [failed, setFailed] = useState(false);
  const hasWholeBoard = Boolean(step.focusImageUrl && step.imageUrl);
  const showWholeBoard = imageView === "whole";
  const imageUrl = showWholeBoard ? step.imageUrl : step.focusImageUrl ?? step.imageUrl;

  useEffect(() => {
    setImageView("focused");
    setFailed(false);
  }, [step.n, step.focusImageUrl, step.imageUrl]);

  if (!imageUrl || failed) {
    return (
      <Box
        role="img"
        aria-label={`Illustration for step ${step.n} is unavailable`}
        sx={{
          minHeight: 150,
          display: "grid",
          placeItems: "center",
          bgcolor: "rgba(255,255,255,0.04)",
          color: "text.secondary",
        }}
      >
        <Stack spacing={0.75} sx={{ alignItems: "center" }}>
          <ImageNotSupportedOutlined aria-hidden="true" />
          <Typography variant="caption">Step illustration unavailable</Typography>
        </Stack>
      </Box>
    );
  }

  const handleImageError = () => {
    if (!showWholeBoard && hasWholeBoard) {
      setImageView("whole");
      return;
    }
    setFailed(true);
  };

  const handleImageViewChange = (_event: MouseEvent<HTMLElement>, next: ImageView | null) => {
    if (next) setImageView(next);
  };

  return (
    <Box>
      <CardMedia
        component="img"
        image={imageUrl}
        alt={`${showWholeBoard ? "Whole board" : "Focused step"} illustration for step ${step.n}: ${step.title}`}
        onError={handleImageError}
        sx={{
          display: "block",
          width: "100%",
          maxHeight: 270,
          objectFit: "contain",
          bgcolor: "rgba(255,255,255,0.04)",
        }}
      />
      {hasWholeBoard && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", px: 1.5, pt: 1 }}>
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
        </Box>
      )}
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

function FinishedBuild({ total }: { total: number }) {
  return (
    <Paper
      component="section"
      aria-label="Build complete"
      variant="outlined"
      sx={{ p: 2.5, borderRadius: 3, borderWidth: 2, borderColor: "success.main", bgcolor: "rgba(62, 189, 126, 0.1)" }}
    >
      <Stack spacing={1.25} sx={{ alignItems: "flex-start" }}>
        <CheckCircleOutlined color="success" sx={{ fontSize: 38 }} aria-hidden="true" />
        <Typography component="h2" variant="h5" sx={{ fontWeight: 800 }}>
          All {total} steps done — now test it at the bench on your laptop
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Open Bench on your laptop to run the safe checks.
        </Typography>
      </Stack>
    </Paper>
  );
}


function StepCard({ step, total, reducedMotion }: { step: BuildStep; total: number; reducedMotion: boolean }) {
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
      <StepImage key={step.n} step={step} />
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
            sx={{ mt: 2, p: 1.5, borderRadius: 2.5, bgcolor: "rgba(96, 165, 250, 0.08)" }}
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
        <Link href="/settings" underline="hover" sx={{ display: "inline-block", mt: 0.75, py: 0.25 }}>
          Connect Claude in Settings
        </Link>
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
        sx={{ width: "100%", maxHeight: 270, objectFit: "contain", borderRadius: 2, bgcolor: "rgba(255,255,255,0.04)" }}
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
  const [photoResult, setPhotoResult] = useState<PhotoCheckResult | null>(null);
  const [photoStep, setPhotoStep] = useState<number | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoResultRef = useRef<HTMLDivElement>(null);
  const safeActiveStep = Math.min(Math.max(activeStep, 0), Math.max(steps.length - 1, 0));
  const lastStepNumber = steps[steps.length - 1]?.n;
  const currentStepNumber = steps[safeActiveStep]?.n;

  useEffect(() => {
    setActiveStep(initialStep);
  }, [initialStep]);

  useEffect(() => {
    setPhotoResult(null);
    setPhotoStep(null);
    setPhotoError(null);
  }, [safeActiveStep]);

  useEffect(() => {
    setFinished(isBuildComplete(build));
  }, [build.headline, build.revision, build.steps.length]);

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

  if (finished) return <FinishedBuild total={steps.length} />;

  const step = steps[safeActiveStep];
  const handlePhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError(null);
    setPhotoResult(null);
    photoMutation.mutate({ step: step.n, file });
  };

  return (
    <Stack spacing={1.5}>
      <PlugBanner plug={step.plug} reducedMotion={reducedMotion} />
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
            disabled={safeActiveStep === 0}
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
            disabled={safeActiveStep === steps.length - 1}
            endIcon={<KeyboardArrowRight />}
            sx={{ minWidth: 84, minHeight: 44 }}
          >
            Next
          </Button>
        }
      />

      <StepCard step={step} total={steps.length} reducedMotion={reducedMotion} />

      <Button
        type="button"
        variant="contained"
        size="large"
        fullWidth
        onClick={() => stepMutation.mutate(step.n)}
        disabled={stepMutation.isPending}
        aria-busy={stepMutation.isPending}
        sx={{ minHeight: 52, borderRadius: 2.5, fontWeight: 800 }}
      >
        {stepMutation.isPending ? <CircularProgress color="inherit" size={22} /> : "I did this"}
      </Button>
      {stepMutation.error && (
        <Alert severity="error" icon={<CloudOffOutlined />}>
          <AlertTitle>Could not save this step</AlertTitle>
          {errorMessage(stepMutation.error)}
        </Alert>
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

export interface BuildModePageProps {
  missionId?: string;
}

export default function BuildModePage({ missionId: missionIdProp }: BuildModePageProps = {}) {
  const { missionId: routeMissionId } = useParams<{ missionId: string }>();
  const missionId = missionIdProp ?? routeMissionId ?? "";
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const [now, setNow] = useState(() => Date.now());
  const [showPwaTip, setShowPwaTip] = useState(false);
  const query = useQuery({
    queryKey: buildQueryKey(missionId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchBuildState(missionId, signal),
    enabled: missionId.length > 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setShowPwaTip(shouldShowPwaTip());
  }, []);

  const dismissPwaTip = () => {
    try {
      window.localStorage.setItem(PWA_TIP_STORAGE_KEY, "1");
    } catch {
      // Private browsing can deny storage; dismiss for this view regardless.
    }
    setShowPwaTip(false);
  };

  if (!missionId) {
    return (
      <Box component="main" sx={{ minHeight: "100svh", p: 2 }}>
        <Alert severity="error" icon={<ErrorOutlined />}>
          <AlertTitle>Build link is incomplete</AlertTitle>
          This page needs a mission id. Open Build Mode again from Mission Control.
        </Alert>
      </Box>
    );
  }

  const build = query.data;
  const stale = Boolean(build && query.dataUpdatedAt > 0 && now - query.dataUpdatedAt > STALE_AFTER_MS);
  const headline = build?.headline?.trim() || "Build checklist ready";

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
            {stale && (
              <Chip
                icon={<WifiOff />}
                label={`Connection stale · ${ageLabel(query.dataUpdatedAt, now)}`}
                color="warning"
                variant="outlined"
                sx={{
                  alignSelf: { xs: "flex-start", sm: "flex-end" },
                  minHeight: 36,
                  maxWidth: 230,
                  "& .MuiChip-label": { whiteSpace: "nowrap" },
                }}
              />
            )}
          </Stack>
          {showPwaTip && (
            <Alert
              severity="info"
              onClose={dismissPwaTip}
              closeText="Dismiss Add to Home Screen tip"
              sx={{ alignItems: "center", "& .MuiAlert-message": { fontSize: "0.875rem", lineHeight: 1.45 } }}
            >
              Add to Home Screen: tap Share, then Add to Home Screen — the build opens like an app.
            </Alert>
          )}

          <Alert severity={stale ? "warning" : "info"} icon={stale ? <WifiOff /> : <FactCheckOutlined />} role="status">
            <AlertTitle>{headline}</AlertTitle>
            {stale ? "The last successful update is old. Showing the last known checklist." : "Follow one step at a time."}
          </Alert>

          {query.error && build && (
            <Alert severity="warning" icon={<CloudOffOutlined />}>
              <AlertTitle>Waiting for Mission Control</AlertTitle>
              {errorMessage(query.error)}
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
          )}

          {build && <BuildChecklist missionId={missionId} build={build} />}
        </Stack>
      </Box>
    </Box>
  );
}
