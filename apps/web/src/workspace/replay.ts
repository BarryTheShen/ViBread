import type { TraceFrame } from "@vibread/core";

/** Index of the frame in effect at virtual time `t` (last frame with `frame.t <= t`); frames are sorted by `t`. */
export function frameIndexAt(frames: readonly TraceFrame[], t: number): number {
  if (frames.length === 0 || t < frames[0].t) return 0;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Applies one trace frame to an inlined breadboard SVG using the shared id convention: LED `glow-<ID>` opacity =
 * brightness, buzzer `sound-<ID>` opacity = 0/1. Part ids are reference designators (`LED1`), safe as element ids.
 */
export function applyFrame(root: ParentNode, frame: TraceFrame): void {
  for (const [part, value] of Object.entries(frame.parts)) {
    const level = String(Math.max(0, Math.min(1, value)));
    const glow = root.querySelector<SVGElement>(`[id="glow-${part}"]`);
    if (glow) glow.style.opacity = level;
    const sound = root.querySelector<SVGElement>(`[id="sound-${part}"]`);
    if (sound) sound.style.opacity = level;
  }
}

/** Plain-language state of a traced part for the accessible readout next to the animation. */
export function describePartState(part: string, value: number): string {
  if (part.startsWith("LED")) return value >= 0.05 ? `${part} on (${Math.round(value * 100)}%)` : `${part} off`;
  if (part.startsWith("BZ")) return value > 0 ? `${part} sounding` : `${part} quiet`;
  if (part.startsWith("BTN")) return value > 0 ? `${part} pressed` : `${part} released`;
  if (part.startsWith("LDR")) return `${part} light level ${Math.round(value * 100)}%`;
  if (part.startsWith("POT")) return `${part} knob at ${Math.round(value * 100)}%`;
  return `${part} = ${Math.round(value * 100) / 100}`;
}
