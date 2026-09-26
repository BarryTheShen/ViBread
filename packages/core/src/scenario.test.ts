import { describe, expect, it } from "vitest";
import { ScenarioStepSchema } from "./scenario.js";

describe("shared part expectations", () => {
  it("parses both scenario spellings and brightness bounds", () => {
    expect(ScenarioStepSchema.parse({ "expect-parts": { checks: [{ part: "LED1", state: "off" }, { part: "LED2", minBrightness: 0.2, maxBrightness: 0.8 }], windowMs: 50 } })).toEqual({
      "expect-parts": { checks: [{ part: "LED1", state: "off" }, { part: "LED2", minBrightness: 0.2, maxBrightness: 0.8 }], windowMs: 50 },
    });
    expect(ScenarioStepSchema.parse({ kind: "expect-parts", checks: [{ part: "LED1", state: "on" }], windowMs: 25 })).toMatchObject({ kind: "expect-parts", windowMs: 25 });
  });
});
