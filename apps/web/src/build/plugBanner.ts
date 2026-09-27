import type { Step } from "@vibread/core";

export interface PlugInstruction {
  plugged: boolean;
  /** What to do with the cable on this step. */
  action: string;
  /** True when this step changes the cable from the step before (plug in now / unplug now). */
  change: boolean;
}

/**
 * The USB banner for one step. A step's `plug` is the state while you do it, so the banner says "Unplug the USB cable
 * now" on the step that follows a plugged-in checkpoint, "Plug the USB cable in now" on a checkpoint, and "keep" otherwise.
 * `previous` is the step before in the list (undefined for the first step, where the board starts unplugged).
 */
export function plugInstruction(plug: Step["plug"], previous: Step["plug"] | undefined): PlugInstruction {
  const plugged = plug === "plugged";
  const change = plug !== (previous ?? "unplugged");
  if (plugged) {
    return { plugged, change, action: change ? "Plug the USB cable in now" : "Keep the USB cable plugged in" };
  }
  return { plugged, change, action: change ? "Unplug the USB cable now" : "Keep the USB cable unplugged" };
}
