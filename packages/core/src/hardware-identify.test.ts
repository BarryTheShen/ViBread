import { describe, expect, it } from "vitest";
import { interpretHardwareAnswer, type HardwareAnswer } from "./catalog.js";

const answer = (overrides: Partial<HardwareAnswer>): HardwareAnswer => ({
  kind: "breadboard",
  id: "bb-400",
  confidence: "high",
  reasons: ["counted 30 numbered rows"],
  description: "white half-size breadboard",
  ...overrides,
});

describe("interpreting a photo identification", () => {
  it("keeps a catalogue match that agrees with what was seen, and offers the others", () => {
    const result = interpretHardwareAnswer(answer({ rows: 30, rails: true, railGap: false }));
    expect(result).toMatchObject({ kind: "breadboard", profileOrVariantId: "bb-400", confidence: "high", reasons: ["counted 30 numbered rows"] });
    expect(result.alternatives).toEqual(["bb-830", "bb-170", "bb-830-split"]);
  });

  it("lets the counted rows and rails overrule the model's pick", () => {
    const mini = interpretHardwareAnswer(answer({ id: "bb-400", rows: 17, rails: false }));
    expect(mini.profileOrVariantId).toBe("bb-170");
    expect(mini.confidence).toBe("medium");
    expect(mini.reasons.at(-1)).toContain("170-point mini board");

    const split = interpretHardwareAnswer(answer({ id: "bb-830", rows: 63, railGap: true }));
    expect(split.profileOrVariantId).toBe("bb-830-split");

    // Rows alone can't separate the two 830s: the model's pick stands.
    expect(interpretHardwareAnswer(answer({ id: "bb-830-split", rows: 63 })).profileOrVariantId).toBe("bb-830-split");
    // No pick but a telling count still names the board.
    expect(interpretHardwareAnswer(answer({ kind: "unknown", id: null, rows: 30, rails: true, railGap: false }))).toMatchObject({ kind: "breadboard", profileOrVariantId: "bb-400", confidence: "medium" });
  });

  it("never names something outside the catalogue", () => {
    const made = interpretHardwareAnswer(answer({ id: "bb-1660" }));
    expect(made).toMatchObject({ profileOrVariantId: null, confidence: "low" });
    expect(made.reasons.at(-1)).toContain("bb-1660");
    // A part id offered as a breadboard is rejected too.
    expect(interpretHardwareAnswer(answer({ id: "led-5mm" })).profileOrVariantId).toBeNull();
    expect(interpretHardwareAnswer(answer({ rows: 45, id: null })).reasons.at(-1)).toContain("45 rows");
  });

  it("marks a guess of the wrong kind and a board a photo can't tell apart as uncertain", () => {
    const wrongKind = interpretHardwareAnswer(answer({ kind: "part", id: "led-3mm" }), "breadboard");
    expect(wrongKind).toMatchObject({ kind: "part", profileOrVariantId: "led-3mm", confidence: "low" });

    const nano = interpretHardwareAnswer(answer({ kind: "board", id: "nano-new", reasons: ["two rows of 15 pins"] }));
    expect(nano.confidence).toBe("medium");
    expect(nano.reasons.at(-1)).toMatch(/can't tell the old and new/);
    expect(interpretHardwareAnswer(answer({ kind: "board", id: "uno-r3-ch340", reasons: ["chip marked CH340G"] })).confidence).toBe("high");
    expect(interpretHardwareAnswer(answer({ kind: "part", id: "button-2leg", reasons: ["two legs"] }))).toMatchObject({ profileOrVariantId: "button-2leg", confidence: "high" });
  });
});
