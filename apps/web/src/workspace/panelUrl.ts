import type { MissionDetail } from "@vibread/core";
import type { PanelView } from "../contracts.js";
import { panelViewFor } from "./panelViews.js";

/**
 * The mission panel's state lives in the page URL (`?panel=code&rev=1&console=GUIDO`), so a reload or a shared link
 * shows the same view and design version. `panel=off` = closed on purpose; no `panel` = not chosen yet (defaults).
 */
export interface PanelState {
  open: boolean;
  view: PanelView;
  revision?: number;
  console?: string;
}

const CONSOLES = ["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"];

/** The view a mission opens on when nobody picked one: Build steps while building, Bench results after a failed bench test. */
export function defaultPanelView(detail: MissionDetail | undefined): PanelView {
  const phase = detail?.mission.phase;
  if (phase === "ASSEMBLE") return "steps";
  if (phase === "DEBUG") return "results";
  return "schematic";
}

/** Panel state from the URL. Unknown views and design versions that don't exist fall back to the defaults. */
export function readPanel(params: URLSearchParams, detail: MissionDetail | undefined, roomy: boolean): PanelState {
  const raw = params.get("panel");
  const view = panelViewFor(raw);
  const latest = detail?.mission.currentRevision;
  const rev = Number(params.get("rev"));
  const revision = Number.isInteger(rev) && rev >= 1 && latest !== undefined && rev <= latest ? rev : undefined;
  const console = params.get("console") ?? undefined;
  if (raw === "off") return { open: false, view: defaultPanelView(detail) };
  if (!view) return { open: roomy && latest !== undefined, view: defaultPanelView(detail), ...(revision ? { revision } : {}) };
  return { open: true, view, ...(revision ? { revision } : {}), ...(view === "checks" && console && CONSOLES.includes(console) ? { console } : {}) };
}

/** A copy of `params` describing `state` (other search params are kept). */
export function writePanel(params: URLSearchParams, state: PanelState): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("panel", state.open ? state.view : "off");
  if (state.open && state.revision !== undefined) next.set("rev", String(state.revision));
  else next.delete("rev");
  if (state.open && state.console) next.set("console", state.console);
  else next.delete("console");
  // The bench's checkpoint scope (`tests`, `returnTo`) belongs to that bench visit only.
  if (!state.open || state.view !== "bench") for (const key of BENCH_PARAMS) next.delete(key);
  return next;
}

const BENCH_PARAMS = ["tests", "step", "returnTo"] as const;

/**
 * The panel after an automatic open (first design, GO for build, a failed bench run). The bench is never switched away
 * from: it holds the USB connection, the flash/self-test progress and the build step's scope, and its own failing run
 * is exactly what the person is looking at.
 */
export function autoOpenedPanel(current: PanelState, view: PanelView): PanelState {
  return current.open && current.view === "bench" ? current : { open: true, view };
}

/** An old panel id in the URL (`?panel=replay`) → the same params with its current view; undefined when already current. */
export function canonicalPanelParams(params: URLSearchParams): URLSearchParams | undefined {
  const raw = params.get("panel");
  const view = panelViewFor(raw);
  if (!view || view === raw) return undefined;
  const next = new URLSearchParams(params);
  next.set("panel", view);
  return next;
}

/** `/m/:id/bench?tests=…&returnTo=…` (the old bench page) → the mission page with the bench open in its panel. */
export function benchPanelPath(missionId: string, search: string): string {
  const old = new URLSearchParams(search);
  const next = new URLSearchParams({ panel: "bench" });
  for (const key of BENCH_PARAMS) {
    const value = old.get(key);
    if (value) next.set(key, value);
  }
  return `/m/${encodeURIComponent(missionId)}?${next.toString()}`;
}
