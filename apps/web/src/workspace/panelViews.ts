import { PANEL_VIEWS, type PanelView } from "../contracts.js";

/**
 * The panel's Show menu, by project stage and in build order (issue #24). Merged views:
 * - Tests + Replay → "Tests": every simulated scenario and its replay are one thing, so each scenario row has its replay.
 * - Telemetry + Diagnosis → "Bench results": both read the same bench runs (what the board reported, and what's likely
 *   wrong); one view shows the latest run's diagnosis on the breadboard, then every test result and earlier runs.
 * - The bench itself is a regular view ("Bench") instead of a separate page.
 */
export const PANEL_STAGES: readonly { n: number; title: string; views: readonly PanelView[] }[] = [
  { n: 1, title: "Design", views: ["parts", "schematic", "code"] },
  { n: 2, title: "Simulate", views: ["tryit", "tests", "checks"] },
  { n: 3, title: "Build", views: ["steps", "bench", "photos"] },
  { n: 4, title: "Debug", views: ["results"] },
];

export const PANEL_VIEW_LABELS: Record<PanelView, string> = {
  parts: "Parts",
  schematic: "Schematic",
  code: "Code",
  tryit: "Try it",
  tests: "Tests",
  checks: "Checks",
  steps: "Build steps",
  bench: "Bench",
  photos: "Photo checks",
  results: "Bench results",
};

/** One line under each menu entry: what you do there. */
export const PANEL_VIEW_HINTS: Record<PanelView, string> = {
  parts: "What the design uses vs your parts",
  schematic: "The circuit drawing",
  code: "The Arduino sketch",
  tryit: "Run your code on a simulated board",
  tests: "Simulated scenarios, each with its replay",
  checks: "The five Go/No-Go checks",
  steps: "Build it step by step",
  bench: "Flash and self-test your board",
  photos: "Claude looks at photos of your build",
  results: "What the board reported and what's likely wrong",
};

/** Ids from before the merge (old links, bookmarks, timeline rows) and the view that replaced them. */
const LEGACY_VIEWS: Record<string, PanelView> = { replay: "tests", telemetry: "results", diagnosis: "results" };

/** A panel id from a URL or an old link → the current view, or undefined when it isn't one. */
export function panelViewFor(raw: string | null | undefined): PanelView | undefined {
  if (!raw) return undefined;
  return PANEL_VIEWS.find((v) => v === raw) ?? LEGACY_VIEWS[raw];
}

/** "3 Build · Bench": where a view sits, for its menu label and the closed Select. */
export function stageOf(view: PanelView): { n: number; title: string } {
  const stage = PANEL_STAGES.find((s) => s.views.includes(view));
  return stage ? { n: stage.n, title: stage.title } : { n: 0, title: "" };
}
