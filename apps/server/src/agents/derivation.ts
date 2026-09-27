import { hashJson } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { DERIVATION_VERSION } from "@vibread/tools";

/**
 * The running code's derivation version (RevisionResults.derivation): the hand-bumped DERIVATION_VERSION plus a
 * fingerprint of what the assembly code derives for the golden designs — layout, build steps, placement summary, a step
 * drawing and a schematic. A change to layout, steps or drawings changes the fingerprint by itself, so revisions derived
 * by older code are re-derived on the next start without anyone remembering to bump the constant (issue #22's steps
 * would otherwise stay old). Deterministic (the same code gives the same version on every machine and run).
 */
export async function derivationVersion(manual = DERIVATION_VERSION): Promise<string> {
  const lib = await import("@vibread/assembly"); // loaded like the pipeline loads it (see pipeline.ts)
  const probe = GOLDEN.map((golden) => {
    const layout = lib.layoutBoard(golden.circuit);
    const steps = lib.buildSteps(golden.circuit, layout);
    const middle = steps.steps[Math.floor(steps.steps.length / 2)];
    const drawing = middle
      ? lib.renderBreadboardSvg({ circuit: golden.circuit, layout, steps, upToStep: middle.n, highlight: { holes: middle.holes, parts: middle.adds.parts, jumpers: middle.adds.jumpers } })
      : "";
    return { key: golden.key, layout, steps, placement: lib.placementSummary(golden.circuit, layout), drawing };
  });
  const smallest = [...GOLDEN].sort((a, b) => a.circuit.parts.length - b.circuit.parts.length)[0]!;
  const schematic = await lib.renderSchematicSvg(smallest.circuit);
  return `${manual}-${hashJson({ probe, schematic }).slice(0, 16)}`;
}

/**
 * derivationVersion, computed once on first use (after the server is listening: it takes about a second). Undefined when
 * the probe itself fails (a broken assembly module): nothing is stamped or re-derived then, and `onError` hears why.
 */
export function lazyDerivationVersion(onError: (error: unknown) => void): () => Promise<string | undefined> {
  let version: Promise<string | undefined> | undefined;
  return () =>
    (version ??= derivationVersion().catch((error: unknown) => {
      onError(error);
      return undefined;
    }));
}
