import type { MissionStore, PhotoCheckResult } from "@vibread/core";
import { ToolInputError } from "@vibread/tools";
import { Output, generateText } from "ai";
import type { Logger } from "pino";
import sharp from "sharp";
import { z } from "zod";
import type { AgentModels } from "./models.js";
import { PHOTO_SYSTEM } from "./prompts.js";

const PhotoAnswerSchema = z.object({
  answers: z.array(
    z.object({
      part: z.string(),
      status: z.enum(["correct", "wrong", "missing", "unknown"]),
      note: z.string(),
    }),
  ),
  summary: z.string().describe("One plain sentence for the builder."),
});

/** Longest edge sent to Claude; keeps image tokens bounded while holes stay readable. */
const MAX_EDGE = 1568;

/**
 * Advisory photo check (PLAN §5.9): photo + the expected step PNG + expected placements → per-part answer with `unknown`
 * allowed. Uses the released revision (the build target), else the latest. Never blocks, never overrides telemetry.
 */
export function createPhotoChecker(deps: { models: AgentModels; store: MissionStore; log: Logger }) {
  return {
    async check(input: { missionId: string; step: number; jpeg: Uint8Array }): Promise<PhotoCheckResult> {
      const mission = await deps.store.getMission(input.missionId);
      if (!mission) throw new ToolInputError(`Mission ${input.missionId} does not exist.`, 404);
      const { model, modelId } = await deps.models.fast(mission.ownerId);
      const n = mission.releasedRevision ?? mission.currentRevision;
      const revision = n === undefined ? null : await deps.store.getRevision(input.missionId, n);
      if (!revision) throw new ToolInputError("This mission has no design to compare the photo with.");
      const steps = revision.results.steps?.steps ?? [];
      const step = steps.find((s) => s.n === input.step);
      if (!step) throw new ToolInputError(`Revision ${revision.n} has no step ${input.step}.`);

      const upTo = steps.filter((s) => s.n <= step.n);
      const placedParts = new Set(upTo.flatMap((s) => s.adds.parts));
      const placedJumpers = new Set(upTo.flatMap((s) => s.adds.jumpers));
      const layout = revision.results.layout;
      const expected = {
        step: { n: step.n, title: step.title, text: step.text, plug: step.plug },
        parts: revision.circuit.parts
          .filter((p) => placedParts.has(p.id))
          .map((p) => ({ id: p.id, module: p.module, label: p.label, params: p.params, holes: layout?.placements.find((pl) => pl.part === p.id)?.pins })),
        jumpers: layout?.jumpers.filter((j) => placedJumpers.has(j.id)) ?? [],
      };

      const photo = await sharp(input.jpeg).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      const pngKey = revision.results.artifacts[`step-${step.n}.png`];
      const reference = pngKey ? await deps.store.getArtifact(pngKey) : null;

      const result = await generateText({
        model,
        system: PHOTO_SYSTEM,
        output: Output.object({ schema: PhotoAnswerSchema, name: "photo_check" }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `Expected state after this step:\n${JSON.stringify(expected, null, 2)}` },
              ...(reference ? [{ type: "text" as const, text: "Expected picture:" }, { type: "file" as const, data: reference.data, mediaType: "image/png" }] : []),
              { type: "text", text: "The builder's photo:" },
              { type: "file", data: new Uint8Array(photo), mediaType: "image/jpeg" },
            ],
          },
        ],
      });

      const known = new Set(expected.parts.map((p) => p.id));
      const answers = result.output.answers.filter((a) => known.has(a.part));
      for (const id of known) if (!answers.some((a) => a.part === id)) answers.push({ part: id, status: "unknown", note: "Not assessed in the photo." });
      const check: PhotoCheckResult = { step: step.n, answers, summary: result.output.summary, advisory: true, model: modelId };
      // Persisting (results.photos + "photo.checked" timeline event) is the photo route's job (ServerCore).
      deps.log.info({ missionId: input.missionId, step: step.n, revision: revision.n }, "photo checked");
      return check;
    },
  };
}
