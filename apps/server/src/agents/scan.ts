import type { PartType, ScanObservation } from "@vibread/core";
import { Output, generateText } from "ai";
import sharp from "sharp";
import { z } from "zod";
import type { AgentModels } from "./models.js";

/**
 * Camera scan (docs/ui-redesign-plan.md §5.6): Claude reports only what it sees in photos of parts; our normalizer
 * (ServerCore/Catalog) turns observations into values. Photos are resized here to exactly what the high-resolution
 * vision tier accepts, so the boxes Claude returns are pixels of the image we keep — crops are cut from that image.
 */

/** Claude's high-resolution vision tier (Sonnet 5): long edge and visual-token budget (platform docs, "Vision"). */
export const HIGH_RES_LIMITS = { maxEdge: 2576, maxTokens: 4784, patch: 28 } as const;

/**
 * Largest aspect-preserving size that fits the tier: both edges (rounded up to a patch) within maxEdge, and
 * ⌈w/28⌉·⌈h/28⌉ visual tokens within maxTokens. Images that already fit are unchanged, so Claude doesn't rescale them
 * and returned coordinates map 1:1 onto the image we store.
 */
export function visionSize(width: number, height: number, limits: { maxEdge: number; maxTokens: number; patch: number } = HIGH_RES_LIMITS): { width: number; height: number } {
  const { maxEdge, maxTokens, patch } = limits;
  const fits = (w: number, h: number) =>
    Math.ceil(w / patch) * patch <= maxEdge && Math.ceil(h / patch) * patch <= maxEdge && Math.ceil(w / patch) * Math.ceil(h / patch) <= maxTokens;
  if (fits(width, height)) return { width, height };
  const portrait = height > width;
  const long = portrait ? height : width;
  const ratio = portrait ? height / width : width / height;
  // Half-to-even for the short edge, the rounding the API uses at exact .5 ties.
  const shortFor = (l: number) => {
    const exact = l / ratio;
    const floor = Math.floor(exact);
    const rounded = exact - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(exact);
    return Math.max(1, rounded);
  };
  let lo = 1;
  let hi = long;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = portrait ? fits(shortFor(mid), mid) : fits(mid, shortFor(mid));
    if (ok) lo = mid;
    else hi = mid;
  }
  return portrait ? { width: shortFor(lo), height: lo } : { width: lo, height: shortFor(lo) };
}

export interface AnalyzedPhoto {
  width: number;
  height: number;
  jpeg: Buffer;
}

/** EXIF-rotates, resizes to the vision tier, re-encodes as JPEG. */
export async function prepareForVision(photo: Buffer): Promise<AnalyzedPhoto> {
  const rotated = await sharp(photo).rotate().toBuffer({ resolveWithObject: true });
  const size = visionSize(rotated.info.width, rotated.info.height);
  const pipeline = sharp(rotated.data);
  if (size.width !== rotated.info.width || size.height !== rotated.info.height) pipeline.resize(size.width, size.height, { fit: "fill" });
  const jpeg = await pipeline.jpeg({ quality: 88 }).toBuffer();
  return { width: size.width, height: size.height, jpeg };
}

const BoxSchema = z
  .array(z.number().int().nonnegative())
  .length(4)
  .describe("[x, y, width, height] in pixels of this photo (top-left origin), around the whole group");

/** One group as Claude reports it (ScanObservation fields; photoIndex is attached per photo by us). */
export const ScanGroupSchema = z.object({
  typeId: z.string().nullable().describe("A catalog type id from the list, or null when unsure"),
  label: z.string().min(1).max(80).describe("Short description in your words, e.g. 'blue 4-pin module'"),
  count: z.number().int().min(0).max(200).describe("How many of this part you can see in the group"),
  confidence: z.enum(["high", "check", "unknown"]),
  box: BoxSchema,
  lensColor: z.string().optional().describe("LEDs: the lens colour you see"),
  bands: z.array(z.string()).optional().describe("Resistors: band colours left to right as seen"),
  printed: z.string().optional().describe("Printed text or codes you can read (e.g. '103', 'B10K', 'SG90')"),
  pins: z.number().int().min(0).max(64).optional().describe("Pins or leads you can count"),
  notes: z.string().max(200).optional(),
});
export const ScanPhotoSchema = z.object({ groups: z.array(ScanGroupSchema).max(40) });

export function scanSystemPrompt(types: PartType[]): string {
  const catalog = types
    .map((t) => `- ${t.id}: ${t.name}${t.aliases.length ? ` (also called: ${t.aliases.join(", ")})` : ""}${t.builtIn ? "" : " [the user's own type]"} — ${t.photoHint}`)
    .join("\n");
  return `You identify electronics parts in a photo for a beginner's parts inventory. Report ONLY what you can see.

Part types you may use (typeId must be one of these ids, or null):
${catalog}

For each group of the same part (parts of one kind lying together):
- typeId from the list, or null if you can't tell — never force a match.
- count: how many you can see (say "check" confidence if parts overlap or are hard to count).
- box: [x, y, width, height] in pixels of THIS photo, enclosing the whole group.
- LEDs: lensColor exactly as seen (a clear lens is "clear", not a guess of the light colour).
- Resistors: bands = band colours from left to right as they appear in the photo. Do not decode a value.
- printed: any text or code you can read on the part or its tape/bag, verbatim.
- pins: leads or header pins you can count.
Never guess values you cannot see. confidence "high" only when the type and every reported detail are clearly visible,
"check" when something is uncertain, "unknown" when you can't tell what it is.`;
}

/**
 * Identifies parts in photos (docs/ui-redesign-plan.md §5.6). Credential: the owner's Claude account, else the server
 * key, else ClaudeNotConnectedError (models.ts) — same as the photo check. One call per photo (low effort).
 */
export async function identifyParts(
  deps: { models: AgentModels },
  input: { ownerId: string; photos: Buffer[]; types: PartType[]; signal?: AbortSignal },
): Promise<{ observations: ScanObservation[]; analyzed: AnalyzedPhoto[] }> {
  const { model } = await deps.models.fast(input.ownerId, { missionId: null, purpose: "scan" });
  const analyzed = await Promise.all(input.photos.map((photo) => prepareForVision(photo)));
  const system = scanSystemPrompt(input.types);
  const known = new Set(input.types.map((t) => t.id));
  const observations: ScanObservation[] = [];
  for (const [photoIndex, photo] of analyzed.entries()) {
    const result = await generateText({
      model,
      system,
      output: Output.object({ schema: ScanPhotoSchema, name: "scan_groups" }),
      providerOptions: { anthropic: { effort: "low" } },
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: new Uint8Array(photo.jpeg), mediaType: "image/jpeg" },
            { type: "text", text: `This photo is ${photo.width}×${photo.height} px. List every group of parts you can see.` },
          ],
        },
      ],
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    for (const group of result.output.groups) {
      const [x, y, w, h] = clampBox(group.box as [number, number, number, number], photo);
      observations.push({
        photoIndex,
        typeId: group.typeId && known.has(group.typeId) ? group.typeId : null,
        label: group.label,
        count: group.count,
        confidence: group.typeId && !known.has(group.typeId) ? "unknown" : group.confidence,
        box: [x, y, w, h],
        ...(group.lensColor ? { lensColor: group.lensColor } : {}),
        ...(group.bands?.length ? { bands: group.bands } : {}),
        ...(group.printed ? { printed: group.printed } : {}),
        ...(group.pins !== undefined ? { pins: group.pins } : {}),
        ...(group.notes ? { notes: group.notes } : {}),
      });
    }
  }
  return { observations, analyzed };
}

/** Keeps a box inside the image (models sometimes overshoot the edge by a few pixels). */
function clampBox(box: [number, number, number, number], image: { width: number; height: number }): [number, number, number, number] {
  const x = Math.min(Math.max(0, Math.round(box[0])), image.width - 1);
  const y = Math.min(Math.max(0, Math.round(box[1])), image.height - 1);
  const w = Math.max(1, Math.min(Math.round(box[2]), image.width - x));
  const h = Math.max(1, Math.min(Math.round(box[3]), image.height - y));
  return [x, y, w, h];
}

/** Cuts a review crop from the analyzed photo: the box grown by `marginPct` of its size on each side, clamped. */
export async function cutCrop(analyzedJpeg: Buffer, box: [number, number, number, number], marginPct = 12): Promise<Buffer> {
  const meta = await sharp(analyzedJpeg).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("The analyzed photo has no size.");
  const [bx, by, bw, bh] = clampBox(box, { width, height });
  const mx = Math.round((bw * marginPct) / 100);
  const my = Math.round((bh * marginPct) / 100);
  const left = Math.max(0, bx - mx);
  const top = Math.max(0, by - my);
  const right = Math.min(width, bx + bw + mx);
  const bottom = Math.min(height, by + bh + my);
  return sharp(analyzedJpeg).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 88 }).toBuffer();
}
