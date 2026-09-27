import {
  BOARD_VARIANTS,
  BREADBOARD_PROFILES,
  HARDWARE_CONFIDENCES,
  HARDWARE_KINDS,
  PART_VARIANTS,
  interpretHardwareAnswer,
  type HardwareIdentification,
  type HardwareKind,
} from "@vibread/core";
import { z } from "zod";
import type { AgentModels } from "./models.js";
import { completeObject } from "./pi-object.js";
import { prepareForVision } from "./scan.js";

/**
 * Identify from a photo (issue #23): which catalogue breadboard, board or part variant is this? Claude reports what
 * it sees (rows counted, a break in the rails, printed markings) and its best match; interpretHardwareAnswer (core)
 * checks the match against those observations and the catalogue before the person confirms it.
 */
export const HardwareAnswerSchema = z.object({
  kind: z.enum([...HARDWARE_KINDS, "unknown"]).describe("What the photo mainly shows"),
  id: z.string().nullable().describe("The matching id from the catalogue list, or null when nothing fits"),
  confidence: z.enum(HARDWARE_CONFIDENCES),
  reasons: z.array(z.string().min(1).max(160)).min(1).max(6).describe("Short things you saw that decided it, e.g. 'counted 30 numbered rows'"),
  description: z.string().min(1).max(200).describe("What it is, in plain words"),
  rows: z.number().int().min(1).max(200).optional().describe("Breadboards: numbered rows you counted (read the highest printed number)"),
  railGap: z.boolean().optional().describe("Breadboards: true when the red/blue rail lines stop in the middle with a gap"),
  rails: z.boolean().optional().describe("Breadboards: false when there are no power rails along the long edges"),
  printed: z.string().max(120).optional().describe("Printed text or markings you can read, verbatim"),
});

export function hardwareSystemPrompt(kind?: HardwareKind): string {
  const breadboards = Object.values(BREADBOARD_PROFILES)
    .map((profile) => `- ${profile.id}: ${profile.name}. ${profile.photoHint} Tell-tales: ${profile.identify.join("; ")}.`)
    .join("\n");
  const boards = Object.values(BOARD_VARIANTS)
    .map((variant) => `- ${variant.id}: ${variant.name}. ${variant.photoHint} Tell-tales: ${variant.identify.join("; ")}.`)
    .join("\n");
  const parts = PART_VARIANTS.map((variant) => `- ${variant.id}: ${variant.name}. ${variant.photoHint} Tell-tales: ${variant.identify.join("; ")}.`).join("\n");
  return `You identify one piece of a beginner's Arduino kit in a photo and match it to ViBread's catalogue.${kind ? ` The person says the photo shows a ${kind}.` : ""}
Report only what you can see.

Breadboards (kind "breadboard"):
${breadboards}

Boards (kind "board"):
${boards}

Parts (kind "part"):
${parts}

How to decide:
- Breadboards: count the numbered rows (read the highest number printed along the edge) and report it as rows; look
  along each red/blue rail line for a break in the middle (railGap); say rails=false when there are no rails at all.
- Boards: read the chip beside the USB socket (CH340G vs a small square ATmega16U2), the logo and the printed name.
- Parts: judge size against the breadboard holes (2.54 mm apart) or other parts, count legs, look for a + mark,
  sticker, flat side or printed value.
- id: the one catalogue id that matches, or null when none does — never force a match. confidence "high" only when the
  deciding detail is clearly visible, "medium" when it is likely, "low" when you are guessing.
- reasons: the concrete things you saw, each short.`;
}

export async function identifyHardware(
  deps: { models: AgentModels },
  input: { ownerId: string; photo: Buffer; kind?: HardwareKind; signal?: AbortSignal },
): Promise<HardwareIdentification> {
  const claude = await deps.models.fast(input.ownerId, { missionId: null, purpose: "scan" });
  const photo = await prepareForVision(input.photo);
  const answer = await completeObject(claude, {
    system: hardwareSystemPrompt(input.kind),
    schema: HardwareAnswerSchema,
    name: "identify_hardware",
    effort: "low",
    content: [
      { type: "image", data: photo.jpeg.toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: input.kind ? `Which ${input.kind} is this?` : "Which breadboard, board or part is this?" },
    ],
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return interpretHardwareAnswer(answer, input.kind);
}
