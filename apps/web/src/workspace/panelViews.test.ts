import { describe, expect, it } from "vitest";
import { PANEL_VIEWS } from "../contracts.js";
import { PANEL_STAGES, panelViewFor, stageOf } from "./panelViews.js";

describe("Show menu stages", () => {
  it("lists every view exactly once, stage by stage in build order", () => {
    expect(PANEL_STAGES.flatMap((s) => s.views)).toEqual([...PANEL_VIEWS]);
    expect(PANEL_STAGES.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });

  it("the bench is a Build view; Tests and Bench results are the merged views", () => {
    expect(stageOf("bench").n).toBe(3);
    expect(stageOf("tests").n).toBe(2);
    expect(stageOf("results").n).toBe(4);
  });

  it("maps old ids to the view that replaced them and rejects unknown ones", () => {
    expect(panelViewFor("replay")).toBe("tests");
    expect(panelViewFor("telemetry")).toBe("results");
    expect(panelViewFor("diagnosis")).toBe("results");
    expect(panelViewFor("bench")).toBe("bench");
    expect(panelViewFor("off")).toBeUndefined();
    expect(panelViewFor(null)).toBeUndefined();
  });
});
