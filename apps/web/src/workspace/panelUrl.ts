import type { MissionDetail } from "@vibread/core";
import { PANEL_VIEWS, type PanelView } from "../contracts.js";

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

/** The view a mission opens on when nobody picked one: Build steps while building, Diagnosis after a failed bench test. */
export function defaultPanelView(detail: MissionDetail | undefined): PanelView {
  const phase = detail?.mission.phase;
  if (phase === "ASSEMBLE") return "steps";
  if (phase === "DEBUG") return "diagnosis";
  return "schematic";
}

/** Panel state from the URL. Unknown views and design versions that don't exist fall back to the defaults. */
export function readPanel(params: URLSearchParams, detail: MissionDetail | undefined, roomy: boolean): PanelState {
  const raw = params.get("panel");
  const view = PANEL_VIEWS.find((v) => v === raw);
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
  return next;
}
