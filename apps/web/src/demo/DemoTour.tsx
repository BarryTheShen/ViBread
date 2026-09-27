import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Popper, { type PopperPlacementType } from "@mui/material/Popper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { PanelView } from "../contracts.js";
import { GET_VIBREAD_URL, getDemoMissionId } from "./demo.js";

/**
 * The demo's guided tour: one card per stop, anchored next to the part of the page it explains, with the rest of the
 * page dimmed around a spotlight. The overlay never takes clicks, so the page stays usable while the tour is open.
 */

interface TourStep {
  title: string;
  body: ReactNode;
  /** CSS selector of the element to highlight; none (or not found in time) = a centered card. */
  target?: string;
  /** Mission panel view the stop needs, opened through the URL like a deep link. */
  panel?: PanelView;
  placement?: PopperPlacementType;
}

const STEPS: readonly TourStep[] = [
  {
    title: "Welcome to ViBread",
    body: "This is a real project recorded in ViBread: a Moon-Phase Lamp built on an Arduino. The tour takes about a minute, and you can close it at any step with the X.",
  },
  {
    title: "Describe it, Claude designs it",
    target: '[data-tour="chat"]',
    placement: "right",
    body: "You describe the gadget in plain words and Claude designs the circuit and the code. This is the real recorded conversation; in the demo it's read-only.",
  },
  {
    title: "Five checks vote GO or NO-GO",
    target: '[data-tour="checks"]',
    placement: "bottom",
    body: "Every design goes through five checks: electrical, firmware, simulation tests, breadboard layout and an independent AI review. All five say GO for this lamp.",
  },
  {
    title: "Everything about the design",
    target: '[data-tour="panel-picker"]',
    panel: "parts",
    placement: "bottom",
    body: "The Show menu switches the panel between the parts, schematic, code, Try it, tests, checks, build steps and the bench.",
  },
  {
    title: "The schematic",
    target: '[data-tour="panel-schematic"]',
    panel: "schematic",
    placement: "left",
    body: "The circuit Claude designed: four LEDs with their resistors, a button and a light sensor, wired to the Arduino.",
  },
  {
    title: "Try it in the browser",
    target: '[data-tour="panel-tryit"]',
    panel: "tryit",
    placement: "left",
    body: "The exact sketch runs on a simulated Arduino right here. Drag the room light slider to Dark, then hold the button to move to the next moon phase.",
  },
  {
    title: "Tests written by a second AI",
    target: '[data-tour="panel-tests"]',
    panel: "tests",
    placement: "left",
    body: "A separate AI wrote these tests from the description, without seeing the code. Press Replay on any test to watch it run on the board.",
  },
  {
    title: "Why each check said GO",
    target: '[data-tour="panel-checks"]',
    panel: "checks",
    placement: "left",
    body: "The details behind every GO or NO-GO, check by check.",
  },
  {
    title: "Build it step by step",
    target: '[data-tour="panel-steps"]',
    panel: "steps",
    placement: "left",
    body: "Numbered, LEGO-style build steps. Each one adds a few parts and shows the exact holes on the breadboard.",
  },
  {
    title: "Follow along on your phone",
    target: '[data-tour="phone"]',
    placement: "bottom",
    body: "This button shows a QR code that opens the same build steps on your phone, one step at a time next to your breadboard.",
  },
  {
    title: "Only a person says GO for build",
    target: '[aria-label^="GO for build"]',
    placement: "top",
    body: "Claude can't release its own design: a design is built only after a person presses GO for build. In this recording, that happened here.",
  },
  {
    title: "Check it on the real board",
    target: '[data-tour="panel-bench"]',
    panel: "bench",
    placement: "left",
    body: "With a real Arduino plugged in, the ViBread desktop app runs a self-test on your wiring and shows where it's wrong. That needs hardware, so it's off in the demo.",
  },
  {
    title: "That's ViBread",
    body: (
      <>
        Design and build your own gadget with the ViBread app.{" "}
        <Link href={GET_VIBREAD_URL} target="_blank" rel="noopener" sx={{ fontWeight: 700 }}>
          Get ViBread
        </Link>
      </>
    ),
  },
];

const DONE_KEY = "vibread.demo.tour.done";
const TARGET_WAIT_MS = 2_000;
const SPOTLIGHT_PAD = 6;
const Z_OVERLAY = 1600;

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Storage blocked (private mode): the tour just starts again next visit.
  }
}

function isDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function findTarget(selector: string): HTMLElement | null {
  try {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? element : null;
  } catch {
    return null;
  }
}

interface Box4 {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The target's box padded and clipped to the viewport, so tall panels still anchor the card on screen. */
function visibleBox(element: HTMLElement): Box4 {
  const rect = element.getBoundingClientRect();
  const top = Math.max(rect.top - SPOTLIGHT_PAD, 0);
  const left = Math.max(rect.left - SPOTLIGHT_PAD, 0);
  const bottom = Math.min(rect.bottom + SPOTLIGHT_PAD, window.innerHeight);
  const right = Math.min(rect.right + SPOTLIGHT_PAD, window.innerWidth);
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

const sameBox = (a: Box4 | null, b: Box4) => a !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/** Tour state for the demo shell: starts once per browser on the mission page; `start` restarts it at step 1. */
export function useDemoTour() {
  const { pathname } = useLocation();
  const [run, setRun] = useState(0);
  const [open, setOpen] = useState(false);
  const autoStarted = useRef(false);
  const start = useCallback(() => {
    autoStarted.current = true;
    setRun((n) => n + 1);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    markDone();
    setOpen(false);
  }, []);
  useEffect(() => {
    if (autoStarted.current || !pathname.startsWith("/m/") || isDone()) return;
    // Once the mission page has rendered (its first highlight target exists), or after 3 s whatever it shows.
    const began = Date.now();
    const timer = window.setInterval(() => {
      if (document.querySelector("[data-tour]") || Date.now() - began > 3_000) {
        window.clearInterval(timer);
        if (!autoStarted.current) start();
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [pathname, start]);
  return { run, open, start, close };
}

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return ["slider", "menuitem", "option", "tab", "listbox", "combobox", "spinbutton"].includes(target.getAttribute("role") ?? "");
}

export function DemoTour({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState<{ index: number; element: HTMLElement | null } | null>(null);
  const [box, setBox] = useState<Box4 | null>(null);
  const boxRef = useRef<Box4 | null>(null);
  const popperRef = useRef<{ update(): void } | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const next = useCallback(() => {
    if (index >= STEPS.length - 1) onClose();
    else setIndex(index + 1);
  }, [index, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // Open the stop's panel (or the mission page) through the URL, exactly like a deep link.
  useEffect(() => {
    const missionPath = `/m/${encodeURIComponent(getDemoMissionId())}`;
    const onMission = location.pathname === missionPath;
    const panel = new URLSearchParams(location.search).get("panel");
    if (step.panel && (!onMission || panel !== step.panel)) navigate(`${missionPath}?panel=${step.panel}`, { replace: true });
    else if (!step.panel && !onMission) navigate(missionPath, { replace: true });
    // Only when the stop changes: the visitor may browse elsewhere while a card is showing.
  }, [index]);

  // Wait (up to ~2 s) for the stop's target, then bring it into view.
  useEffect(() => {
    setFound(null);
    boxRef.current = null;
    setBox(null);
    const selector = step.target;
    if (!selector) {
      setFound({ index, element: null });
      return;
    }
    const began = Date.now();
    let frame = 0;
    const look = () => {
      const element = findTarget(selector);
      if (element) {
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
        setFound({ index, element });
      } else if (Date.now() - began > TARGET_WAIT_MS) {
        setFound({ index, element: null });
      } else {
        frame = window.requestAnimationFrame(look);
      }
    };
    frame = window.requestAnimationFrame(look);
    return () => window.cancelAnimationFrame(frame);
  }, [index, step.target, reducedMotion]);

  // Keep the spotlight and the card on the target through scrolling, resizing and re-renders.
  const element = found?.index === index ? found.element : null;
  useEffect(() => {
    if (!element) return;
    let frame = 0;
    let current = element;
    const track = () => {
      if (!current.isConnected) {
        const again = step.target ? findTarget(step.target) : null;
        if (!again) {
          setFound({ index, element: null });
          return;
        }
        current = again;
      }
      const next = visibleBox(current);
      if (!sameBox(boxRef.current, next)) {
        boxRef.current = next;
        setBox(next);
        popperRef.current?.update();
      }
      frame = window.requestAnimationFrame(track);
    };
    track();
    return () => window.cancelAnimationFrame(frame);
  }, [element, index, step.target]);

  const ready = found?.index === index;
  const spotlight = ready && element !== null && box !== null && box.width > 0 && box.height > 0 ? box : null;

  useEffect(() => {
    if (ready) nextRef.current?.focus({ preventScroll: true });
  }, [ready, index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowRight" && !typingInto(event.target)) {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft" && !typingInto(event.target)) {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onClose]);

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => {
        const b = boxRef.current ?? { top: 0, left: 0, width: 0, height: 0 };
        return DOMRect.fromRect({ x: b.left, y: b.top, width: b.width, height: b.height });
      },
    }),
    [],
  );

  if (!ready) return null;

  const card = (
    <Paper
      role="dialog"
      aria-modal={false}
      aria-labelledby="demo-tour-title"
      elevation={8}
      sx={{ position: "relative", width: "min(360px, calc(100vw - 24px))", p: 2, pt: 1.75, borderRadius: 2, pointerEvents: "auto", border: 1, borderColor: "divider" }}
    >
      <IconButton aria-label="Close tour" size="small" onClick={onClose} sx={{ position: "absolute", top: 6, right: 6 }}>
        <CloseIcon fontSize="small" />
      </IconButton>
      <Typography id="demo-tour-title" variant="subtitle1" component="h2" sx={{ fontWeight: 700, pr: 4, mb: 0.75 }}>
        {step.title}
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {step.body}
      </Typography>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 2 }}>
        <Typography variant="caption" sx={{ color: "text.secondary", flex: 1 }} aria-live="polite">
          {index + 1} of {STEPS.length}
        </Typography>
        <Button size="small" onClick={back} disabled={index === 0}>
          Back
        </Button>
        <Button ref={nextRef} size="small" variant="contained" onClick={next}>
          {last ? "Finish" : "Next"}
        </Button>
      </Stack>
    </Paper>
  );

  const shade = "rgba(8, 10, 20, 0.55)";
  return (
    <>
      {spotlight ? (
        <Box
          aria-hidden
          sx={{
            position: "fixed",
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            borderRadius: 2,
            boxShadow: `0 0 0 9999px ${shade}`,
            outline: "2px solid",
            outlineColor: "primary.light",
            pointerEvents: "none",
            zIndex: Z_OVERLAY,
            transition: reducedMotion ? "none" : "top 160ms ease, left 160ms ease, width 160ms ease, height 160ms ease",
          }}
        />
      ) : (
        <Box aria-hidden sx={{ position: "fixed", inset: 0, bgcolor: shade, pointerEvents: "none", zIndex: Z_OVERLAY }} />
      )}
      {spotlight ? (
        <Popper
          open
          anchorEl={anchor}
          placement={step.placement ?? "bottom"}
          popperRef={(instance) => {
            popperRef.current = instance;
          }}
          modifiers={[
            { name: "offset", options: { offset: [0, 12] } },
            { name: "flip", options: { fallbackPlacements: ["bottom", "top", "left", "right"], padding: 12 } },
            { name: "preventOverflow", options: { padding: 12, altAxis: true, tether: false } },
          ]}
          sx={{ zIndex: Z_OVERLAY + 1, pointerEvents: "none" }}
        >
          {card}
        </Popper>
      ) : (
        <Box sx={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", p: 1.5, pointerEvents: "none", zIndex: Z_OVERLAY + 1 }}>{card}</Box>
      )}
    </>
  );
}
