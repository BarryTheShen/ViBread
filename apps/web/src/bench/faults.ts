import { applyFault } from "@vibread/bench";
import { layoutBoard } from "@vibread/assembly/layout";
import type { Circuit, Layout } from "@vibread/core";
import type { AppliedFault } from "@vibread/bench";
import type { VirtualFault } from "./virtual.js";

/** Apply the shared layout mutant, then return the physical as-built circuit for SimSession. */
export function applyBrowserFault(circuit: Circuit, fault: VirtualFault, layout?: Layout): AppliedFault | undefined {
  if (fault === "none") return undefined;
  const source = layout ?? layoutBoard(circuit);
  return applyFault({ circuit, layout: source, fault });
}

export function circuitWithFault(circuit: Circuit, fault: VirtualFault, layout?: Layout): Circuit {
  return applyBrowserFault(circuit, fault, layout)?.circuit ?? circuit;
}
