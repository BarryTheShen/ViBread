import { BUILT_IN_PART_TYPES, type PartType } from "@vibread/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { anthropicModels } from "./models.js";
import { HIGH_RES_LIMITS, cutCrop, identifyParts, prepareForVision, scanSystemPrompt, visionSize } from "./scan.js";
import { jsonModel, mockModels, scriptedModel } from "./testing.js";

const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#f4f4f0" } }).jpeg().toBuffer();
}

const USER_TYPE: PartType = {
  id: "u-thermistor",
  name: "Thermistor 10k",
  category: "sensors",
  aliases: ["NTC", "MF52"],
  photoHint: "A small black bead on two thin legs.",
  description: "NTC thermistor",
  fields: [],
  support: "modelled",
  mapping: { kind: "modelled", module: "photoresistor" },
  builtIn: false,
};

describe("scan vision", () => {
  it("sizes photos for the high-resolution tier (the docs' worked examples; never over the edge or token budget)", () => {
    expect(visionSize(3840, 2160)).toEqual({ width: 2576, height: 1449 });
    expect(visionSize(2000, 1500)).toEqual({ width: 2000, height: 1500 }); // fits: not resized
    expect(visionSize(1075, 1520)).toEqual({ width: 1075, height: 1520 });
    expect(visionSize(1075, 1520, { maxEdge: 1568, maxTokens: 1568, patch: 28 })).toEqual({ width: 924, height: 1307 });
    for (const [w, h] of [[4032, 3024], [3024, 4032], [8000, 600], [600, 8000], [5000, 5000]] as const) {
      const size = visionSize(w, h);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(HIGH_RES_LIMITS.maxEdge);
      expect(tokens(size.width, size.height)).toBeLessThanOrEqual(HIGH_RES_LIMITS.maxTokens);
      expect(Math.abs(size.width / size.height - w / h)).toBeLessThan(0.02);
    }
  });

  it("re-encodes a phone photo at exactly the analyzed size (EXIF rotation applied)", async () => {
    const rotated = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: "#ddd" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const analyzed = await prepareForVision(rotated);
    const meta = await sharp(analyzed.jpeg).metadata();
    expect([analyzed.width, analyzed.height]).toEqual([meta.width, meta.height]);
    expect(analyzed.height).toBeGreaterThan(analyzed.width); // portrait after rotation
    expect(tokens(analyzed.width, analyzed.height)).toBeLessThanOrEqual(HIGH_RES_LIMITS.maxTokens);
  });

  it("the prompt lists every catalog type (built-in and the user's own) with aliases and photo hints, and forbids guessing", () => {
    const types = [...BUILT_IN_PART_TYPES, USER_TYPE];
    const prompt = scanSystemPrompt(types);
    for (const type of types) expect(prompt).toContain(`- ${type.id}: ${type.name}`);
    expect(prompt).toContain("Thermistor 10k (also called: NTC, MF52) [the user's own type] — A small black bead on two thin legs.");
    expect(prompt).toContain("left to right");
    expect(prompt).toContain("Never guess values you cannot see");
  });

  it("identifies parts with the mock model: one structured call per analyzed photo, unknown type ids become null", async () => {
    const answers = [
      { groups: [{ typeId: "resistor", label: "beige resistors", count: 5, confidence: "high", box: [100, 80, 400, 200], bands: ["red", "red", "brown", "gold"] }] },
      {
        groups: [
          { typeId: "u-thermistor", label: "black bead", count: 2, confidence: "check", box: [10, 10, 99999, 50] },
          { typeId: "flux-capacitor", label: "odd box", count: 1, confidence: "high", box: [0, 0, 20, 20], printed: "OUTATIME" },
        ],
      },
    ];
    const fast = jsonModel(answers);
    const result = await identifyParts(
      { models: mockModels(scriptedModel([]), fast) },
      { ownerId: "operator", photos: [await photo(4032, 3024), await photo(800, 600)], types: [...BUILT_IN_PART_TYPES, USER_TYPE] },
    );
    const phone = visionSize(4032, 3024);
    expect(result.analyzed.map((a) => [a.width, a.height])).toEqual([[phone.width, phone.height], [800, 600]]);
    expect(result.observations).toEqual([
      { photoIndex: 0, typeId: "resistor", label: "beige resistors", count: 5, confidence: "high", box: [100, 80, 400, 200], bands: ["red", "red", "brown", "gold"] },
      { photoIndex: 1, typeId: "u-thermistor", label: "black bead", count: 2, confidence: "check", box: [10, 10, 790, 50] },
      { photoIndex: 1, typeId: null, label: "odd box", count: 1, confidence: "unknown", box: [0, 0, 20, 20], printed: "OUTATIME" },
    ]);
    expect(fast.doGenerateCalls).toHaveLength(2);
    const call = fast.doGenerateCalls[0]!;
    const user = call.prompt.find((m) => m.role === "user") as { content: { type: string; mediaType?: string; text?: string }[] };
    expect(user.content[0]).toMatchObject({ type: "file", mediaType: "image/jpeg" });
    expect(user.content[1]!.text).toContain(`${result.analyzed[0]!.width}×${result.analyzed[0]!.height} px`);
    expect(call.providerOptions?.anthropic).toMatchObject({ effort: "low" });
    expect(call.responseFormat).toMatchObject({ type: "json" });
  });

  it("needs a Claude credential (owner's account or server key)", async () => {
    await expect(
      identifyParts({ models: anthropicModels({ config: { model: "m", fastModel: "f" } }) }, { ownerId: "operator", photos: [await photo(100, 100)], types: [] }),
    ).rejects.toMatchObject({ code: "claude_not_connected" });
  });

  it("cuts crops from the analyzed image with a margin, clamped to the edges", async () => {
    const analyzed = await photo(1000, 800);
    const crop = await sharp(await cutCrop(analyzed, [100, 100, 200, 100])).metadata();
    expect([crop.width, crop.height]).toEqual([248, 124]); // 12 % of 200 = 24 px, 12 % of 100 = 12 px each side
    const edge = await sharp(await cutCrop(analyzed, [950, 750, 100, 100], 50)).metadata();
    expect([edge.width, edge.height]).toEqual([75, 75]); // box clamped to 50×50, +25 px margin left/top, image edge right/bottom
    const tight = await sharp(await cutCrop(analyzed, [0, 0, 1000, 800], 0)).metadata();
    expect([tight.width, tight.height]).toEqual([1000, 800]);
  });
});
