import { describe, expect, it } from "vitest";
import { toolLabel } from "./toolLabels.js";

describe("toolLabel", () => {
  it("labels a tool part that arrived without its name instead of throwing", () => {
    expect(toolLabel(undefined)).toEqual({ active: "Working…", done: "Finished a step" });
  });

  it("falls back to a readable label for tools it doesn't know", () => {
    expect(toolLabel("vibread_list_missions").done).toBe("Finished vibread list missions");
    expect(toolLabel("run_erc").active).toBe("Checking the circuit…");
  });

  it("names the design version a release was for", () => {
    expect(toolLabel("release_revision", { revision: 2 })).toEqual({ active: "Releasing design r2…", done: "Released design r2" });
    expect(toolLabel("release_revision", {}).done).toBe("Released the design for building");
  });
});
