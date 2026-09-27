import CheckCircleIcon from "@mui/icons-material/CheckCircle";
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
import { keyframes } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { GET_VIBREAD_URL, getDemoMissionId } from "./demo.js";

/**
 * The demo's hands-on tour: each card says what to try, rings the control, and waits for the visitor to do it with the
 * real UI (read from the URL, the page and real clicks/scrolls — never from the tour's own buttons). The ring and the
 * card never take clicks meant for the page, and sit below MUI menus and dialogs so those always work.
 */

/** What a step's check can see: the page URL, and what the visitor did since the step started. */
interface StepContext {
  panel: string | null;
  console: string | null;
  startConsole: string | null;
  /** `data-tour` values of targets the visitor clicked or pressed during this step. */
  pressed: Set<string>;
  /** Pixels the visitor scrolled the conversation during this step. */
  chatScrolled: number;
  /** Build step numbers seen in the Build steps panel during this step. */
  buildSteps: Set<number>;
}

interface TourStep {
  title: string;
  body: ReactNode;
  /** What to do, for steps that wait for the visitor. */
  todo?: string;
  /** The element to ring, looked up on every tick (it can appear once the visitor opens a panel). */
  target?: () => Element | null;
  placement?: PopperPlacementType;
  /** Gap between the target and the card; wider next to the Show menu so its dropdown doesn't land on the card. */
  gap?: number;
  /** True once the visitor has done the step's action. */
  done?: (context: StepContext) => boolean;
  /** Text after ✓ when the step completes. */
  doneText?: string;
  /** Keeps a completed step on screen (e.g. while the QR dialog is still open). */
  holdWhile?: () => boolean;
}

const q = (selector: string) => () => document.querySelector(selector);
const panelBody = (view: string) => document.querySelector(`[data-tour="panel-${view}"]`);
const textOf = (element: Element | null) => (element instanceof HTMLElement ? element.innerText : "");
const phoneDialogOpen = () => [...document.querySelectorAll('[role="dialog"]')].some((dialog) => /Phone link/.test(textOf(dialog)));
/** The Show menu, or the view it already shows. */
const pickerOr = (view: string) => () => panelBody(view) ?? document.querySelector('[data-tour="panel-picker"]');

const STEPS: readonly TourStep[] = [
  {
    title: "Welcome to ViBread",
    body: "This is a real project recorded in ViBread: a Moon-Phase Lamp built on an Arduino. Each card tells you what to try; you do it on the page. Close the tour any time with the X.",
  },
  {
    title: "Describe it, Claude designs it",
    body: "You describe the gadget in plain words and Claude designs the circuit and the code. This is the real recorded conversation (read-only here).",
    todo: "Scroll the conversation to read it.",
    target: q('[data-tour="chat"]'),
    placement: "right",
    done: (c) => c.chatScrolled >= 150,
  },
  {
    title: "Five checks vote GO or NO-GO",
    body: "Every design goes through five checks: electrical, firmware, simulation tests, breadboard layout and an independent AI review. All five say GO here.",
    todo: "Click one of the five check icons to see why it said GO.",
    target: q('[data-tour="checks"]'),
    placement: "bottom-start",
    done: (c) => c.pressed.has("checks") || (c.panel === "checks" && c.console !== null && c.console !== c.startConsole),
  },
  {
    title: "Everything about the design",
    body: "The Show menu switches the panel between the parts, schematic, code, Try it, tests, checks, build steps and the bench.",
    todo: "Open the Show menu and pick Schematic.",
    target: pickerOr("schematic"),
    placement: "left-start",
    gap: 120,
    done: (c) => c.panel === "schematic",
  },
  {
    title: "The schematic",
    body: "The circuit Claude designed: four LEDs with their resistors, a button and a light sensor, wired to the Arduino. Next, run it.",
    todo: "Open the Show menu and pick Try it.",
    target: pickerOr("tryit"),
    placement: "left-start",
    gap: 120,
    done: (c) => c.panel === "tryit",
  },
  {
    title: "Try it in the browser",
    body: "The exact sketch runs on a simulated Arduino right here. The lamp only lights up when the room is dark.",
    todo: "Drag the room light slider to Dark.",
    target: q('[data-tour="tryit-light"]'),
    placement: "left",
    done: () => {
      const text = textOf(panelBody("tryit"));
      const level = /light level (\d+)%/.exec(text);
      return /LED\d on/.test(text) || (level !== null && Number(level[1]) <= 10);
    },
  },
  {
    title: "Next phase",
    body: "Each press of the button moves the lamp to the next of 8 moon phases.",
    todo: "Hold the button to move to the next phase.",
    target: q('[data-tour="tryit-button"]'),
    placement: "left",
    done: (c) => c.pressed.has("tryit-button") || document.querySelector('[data-tour="tryit-button"][aria-pressed="true"]') !== null,
  },
  {
    title: "Tests written by a second AI",
    body: "A separate AI wrote the tests from the description, without seeing the code. A replay shows a test running on the board.",
    todo: "Pick Tests in the Show menu, then press Replay on a test.",
    target: () => document.querySelector('[data-tour="replay"]') ?? pickerOr("tests")(),
    placement: "left-start",
    gap: 120,
    done: (c) => c.pressed.has("replay"),
  },
  {
    title: "Build it step by step",
    body: "Numbered, LEGO-style build steps. Each one adds a few parts and shows the exact holes on the breadboard.",
    todo: "Click Build steps at the top, then press Next a couple of times.",
    target: () => panelBody("steps") ?? document.querySelector('[data-tour="build-steps"]'),
    placement: "left-start",
    done: (c) => c.buildSteps.size >= 3,
  },
  {
    title: "Follow along on your phone",
    body: "The same build steps open on your phone, one step at a time next to your breadboard.",
    todo: "Click the phone icon at the top right to see the QR code.",
    target: q('[data-tour="phone"]'),
    placement: "left-start",
    done: (c) => c.pressed.has("phone") || phoneDialogOpen(),
    doneText: "Nice. Close the QR code when you're done.",
    holdWhile: phoneDialogOpen,
  },
  {
    title: "Only a person says GO for build",
    body: "Claude can't release its own design: a design is built only after a person presses GO for build. In this recording, that happened here.",
    target: q('[aria-label^="GO for build"]'),
    placement: "right",
  },
  {
    title: "Check it on the real board",
    body: "With a real Arduino plugged in, the ViBread desktop app runs a self-test on your wiring and shows where it's wrong. That needs hardware, so it's off in the demo.",
    todo: "Pick Bench in the Show menu.",
    target: pickerOr("bench"),
    placement: "left-start",
    gap: 120,
    done: (c) => c.panel === "bench",
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
const ADVANCE_MS = 800;
const RING_PAD = 4;
/** Above page content and the app bar, below MUI menus, popovers and dialogs (1300), so those always stay usable. */
const Z_TOUR = 1250;

const pulse = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 rgba(94, 129, 244, 0.45); }
  50% { box-shadow: 0 0 0 8px rgba(94, 129, 244, 0); }
`;

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

function visible(element: Element | null): element is Element {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

interface Box4 {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The target's box padded and clipped to the viewport, so tall panels still anchor the card on screen. */
function visibleBox(element: Element): Box4 {
  const rect = element.getBoundingClientRect();
  const top = Math.max(rect.top - RING_PAD, 2);
  const left = Math.max(rect.left - RING_PAD, 2);
  const bottom = Math.min(rect.bottom + RING_PAD, window.innerHeight - 2);
  const right = Math.min(rect.right + RING_PAD, window.innerWidth - 2);
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
  const [completed, setCompleted] = useState(false);
  const [element, setElement] = useState<Element | null>(null);
  const [settled, setSettled] = useState(false);
  const [box, setBox] = useState<Box4 | null>(null);
  const boxRef = useRef<Box4 | null>(null);
  const popperRef = useRef<{ update(): void } | null>(null);
  const contextRef = useRef<StepContext | null>(null);
  const searchRef = useRef(location.search);
  searchRef.current = location.search;
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const next = useCallback(() => {
    if (index >= STEPS.length - 1) onClose();
    else setIndex(index + 1);
  }, [index, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // The only navigation the tour does: bring a visitor who is elsewhere to the example mission.
  useEffect(() => {
    const missionPath = `/m/${encodeURIComponent(getDemoMissionId())}`;
    if (location.pathname !== missionPath) navigate(missionPath);
    // Once, when the tour starts.
  }, []);

  // A fresh record of what the visitor does, per step.
  useEffect(() => {
    const params = new URLSearchParams(searchRef.current);
    contextRef.current = { panel: params.get("panel"), console: params.get("console"), startConsole: params.get("console"), pressed: new Set(), chatScrolled: 0, buildSteps: new Set() };
    setCompleted(false);
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), 600);
    return () => window.clearTimeout(timer);
  }, [index]);

  // Real clicks and scrolls on the page (capture phase: seen before any handler can stop them).
  useEffect(() => {
    const lastTop = new WeakMap<Element, number>();
    const onPress = (event: Event) => {
      const hit = event.target instanceof Element ? event.target.closest("[data-tour]") : null;
      const name = hit?.getAttribute("data-tour");
      if (name) contextRef.current?.pressed.add(name);
    };
    const onScroll = (event: Event) => {
      const scroller = event.target instanceof Element ? event.target : document.scrollingElement;
      if (!scroller || !scroller.closest('[data-tour="chat"]')) return;
      const previous = lastTop.get(scroller) ?? scroller.scrollTop;
      lastTop.set(scroller, scroller.scrollTop);
      if (contextRef.current) contextRef.current.chatScrolled += Math.abs(scroller.scrollTop - previous);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("click", onPress, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("click", onPress, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  // Each tick: find the target, follow it, and check whether the visitor has done the step.
  useEffect(() => {
    let frame = 0;
    let lastCheck = 0;
    let current: Element | null = null;
    const tick = (now: number) => {
      const found = step.target?.() ?? null;
      const target = visible(found) ? found : null;
      if (target !== current) {
        current = target;
        setElement(target);
        if (target) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      }
      if (target) {
        const next = visibleBox(target);
        if (!sameBox(boxRef.current, next)) {
          boxRef.current = next;
          setBox(next);
          popperRef.current?.update();
        }
      } else if (boxRef.current) {
        boxRef.current = null;
        setBox(null);
      }
      const context = contextRef.current;
      if (context && step.done && now - lastCheck > 150) {
        lastCheck = now;
        const params = new URLSearchParams(searchRef.current);
        context.panel = params.get("panel");
        context.console = params.get("console");
        const counter = /Step (\d+) of \d+/.exec(textOf(panelBody("steps")));
        if (counter) context.buildSteps.add(Number(counter[1]));
        try {
          if (step.done(context)) setCompleted(true);
        } catch {
          // A check reads the page; never let it break the tour.
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [step, reducedMotion]);

  // Done: show ✓ briefly, then move on (after the step's dialog is closed, if it keeps one open).
  useEffect(() => {
    if (!completed) return;
    let timer = 0;
    const began = Date.now();
    const wait = () => {
      if (Date.now() - began >= ADVANCE_MS && !step.holdWhile?.()) next();
      else timer = window.setTimeout(wait, 150);
    };
    timer = window.setTimeout(wait, 150);
    return () => window.clearTimeout(timer);
  }, [completed, next, step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A menu or dialog is open: its own Escape and arrow keys win.
      if (document.querySelector(".MuiModal-root:not(.MuiModal-hidden)")) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight" && !typingInto(event.target)) next();
      else if (event.key === "ArrowLeft" && !typingInto(event.target)) back();
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

  const gap = step.gap ?? 14;
  const modifiers = useMemo(
    () => [
      { name: "offset", options: { offset: [0, gap] } },
      // Flip only when the card doesn't fit beside the target; sliding along it (preventOverflow) keeps it off the target.
      { name: "flip", options: { fallbackPlacements: ["left", "right", "bottom", "top"], padding: 12, altAxis: false } },
      { name: "preventOverflow", options: { padding: 12, altAxis: true, tether: false } },
    ],
    [gap],
  );

  const ring = element && box && box.width > 0 && box.height > 0 ? box : null;
  // A step whose target isn't there yet waits briefly before falling back to a centered card.
  if (step.target && !ring && !settled) return null;

  const card = (
    <Paper
      role="dialog"
      aria-modal={false}
      aria-labelledby="demo-tour-title"
      elevation={8}
      sx={{ position: "relative", width: "min(340px, calc(100vw - 24px))", p: 2, pt: 1.75, borderRadius: 2, pointerEvents: "auto", border: 1, borderColor: "divider" }}
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
      {step.todo && (
        <Typography variant="body2" sx={{ fontWeight: 700, mt: 1, color: completed ? "success.main" : "text.primary" }} aria-live="polite">
          {completed ? (
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <CheckCircleIcon fontSize="small" /> {step.doneText ?? "Nice!"}
            </Box>
          ) : (
            <>→ {step.todo}</>
          )}
        </Typography>
      )}
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 1.5 }}>
        <Typography variant="caption" sx={{ color: "text.secondary", flex: 1 }}>
          {index + 1} of {STEPS.length}
        </Typography>
        <Button size="small" onClick={back} disabled={index === 0}>
          Back
        </Button>
        {step.done ? (
          <Button size="small" color="inherit" onClick={next} disabled={completed} sx={{ color: "text.secondary" }}>
            Skip
          </Button>
        ) : (
          <Button size="small" variant="contained" onClick={next}>
            {last ? "Finish" : "Next"}
          </Button>
        )}
      </Stack>
    </Paper>
  );

  return (
    <>
      {ring && (
        <Box
          aria-hidden
          sx={{
            position: "fixed",
            top: ring.top,
            left: ring.left,
            width: ring.width,
            height: ring.height,
            borderRadius: 2,
            border: "3px solid",
            borderColor: completed ? "success.main" : "primary.main",
            pointerEvents: "none",
            zIndex: Z_TOUR,
            animation: reducedMotion ? "none" : `${pulse} 1.6s ease-in-out infinite`,
          }}
        />
      )}
      {ring ? (
        <Popper
          open
          anchorEl={anchor}
          placement={step.placement ?? "bottom"}
          popperRef={(instance) => {
            popperRef.current = instance;
          }}
          modifiers={modifiers}
          sx={{ zIndex: Z_TOUR + 1, pointerEvents: "none" }}
        >
          {card}
        </Popper>
      ) : (
        <Box sx={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", p: 1.5, pointerEvents: "none", zIndex: Z_TOUR + 1 }}>{card}</Box>
      )}
    </>
  );
}
