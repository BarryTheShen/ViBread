import type { StepList, TimelineEvent } from "@vibread/core";

/**
 * Build Mode progress (which steps of a revision are done) is kept as timeline events: "build.step" {n} per step the
 * builder ticked off, and "build.progress" {done} when the steps were re-derived by updated code and the progress was
 * mapped onto the new numbering (rederive.ts). The latest build.progress replaces everything ticked before it.
 */
export const BUILD_STEP_EVENT = "build.step";
export const BUILD_PROGRESS_EVENT = "build.progress";

function stepNumber(data: unknown): number | undefined {
  const n = data && typeof data === "object" && "n" in data ? data.n : undefined;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

function doneList(data: unknown): number[] {
  const done = data && typeof data === "object" && "done" in data ? data.done : undefined;
  return Array.isArray(done) ? done.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
}

/** Step numbers done for `revision` (null: no revision — events without one count, as before). */
export function doneSteps(events: TimelineEvent[], revision: number | null): number[] {
  const mine = events.filter((e) => revision === null || e.revision === undefined || e.revision === revision);
  const markerAt = mine.findLastIndex((e) => e.kind === BUILD_PROGRESS_EVENT);
  const done = new Set(markerAt >= 0 ? doneList(mine[markerAt]!.data) : []);
  for (const event of mine.slice(markerAt + 1)) {
    const n = event.kind === BUILD_STEP_EVENT ? stepNumber(event.data) : undefined;
    if (n !== undefined) done.add(n);
  }
  return [...done].sort((a, b) => a - b);
}

/** What a step puts on the board: its parts and wires. */
function adds(step: StepList["steps"][number]): string[] {
  return [...step.adds.parts.map((p) => `part:${p}`), ...step.adds.jumpers.map((j) => `wire:${j}`)];
}

/** Whether two step lists put the same things on the board in the same steps (only text or pictures differ). */
export function sameStepStructure(a: StepList, b: StepList): boolean {
  return a.steps.length === b.steps.length && a.steps.every((step, i) => JSON.stringify(adds(step)) === JSON.stringify(adds(b.steps[i]!)));
}

/**
 * Progress on `before` mapped onto `after` (same placement, re-derived steps): the builder has placed everything the old
 * steps up to the furthest done one add; the new progress is the longest run of new steps from step 1 whose parts and
 * wires are all already placed. A trailing check or plug step is shown again (nothing on the board proves it was done)
 * unless the builder already placed some of what the next step adds: then they were past it. That happens when new steps
 * group differently, e.g. a "Repeat ×N" step that holds units the builder was halfway through.
 * Returns the new done step numbers.
 */
export function remapProgress(before: StepList, after: StepList, done: number[]): number[] {
  const reached = done.length ? Math.max(...done) : 0;
  const placed = new Set(before.steps.filter((s) => s.n <= reached).flatMap(adds));
  const mapped: StepList["steps"] = [];
  for (const step of after.steps) {
    if (!adds(step).every((item) => placed.has(item))) break;
    mapped.push(step);
  }
  const next = after.steps[mapped.length];
  const pastTrailingChecks = next !== undefined && adds(next).some((item) => placed.has(item));
  if (!pastTrailingChecks) while (mapped.length && adds(mapped.at(-1)!).length === 0) mapped.pop();
  return mapped.map((s) => s.n);
}

/** How many parts and wires already on the board the remapped progress doesn't credit (the next steps show them again). */
export function reshownCount(before: StepList, after: StepList, done: number[], mapped: number[]): number {
  const reached = done.length ? Math.max(...done) : 0;
  const credited = new Set(after.steps.filter((s) => mapped.includes(s.n)).flatMap(adds));
  return new Set(before.steps.filter((s) => s.n <= reached).flatMap(adds).filter((item) => !credited.has(item))).size;
}
