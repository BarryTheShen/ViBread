import type { MissionDetail, MissionPhase } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { readPanel, writePanel } from "./panelUrl.js";

const detail = (phase: MissionPhase, currentRevision?: number) =>
  ({ mission: { phase, currentRevision } }) as unknown as MissionDetail; // only the fields the panel URL reads

const read = (query: string, d: MissionDetail | undefined, roomy = true) => readPanel(new URLSearchParams(query), d, roomy);

describe("readPanel", () => {
  it("restores a deep link: view, design version and focused check", () => {
    expect(read("panel=code&rev=1", detail("GONOGO", 2))).toEqual({ open: true, view: "code", revision: 1 });
    expect(read("panel=checks&console=GUIDO", detail("GONOGO", 2))).toEqual({ open: true, view: "checks", console: "GUIDO" });
  });

  it("without a choice opens on Build steps while building and Diagnosis after a failed bench test, only on a roomy screen with a design", () => {
    expect(read("", detail("ASSEMBLE", 1))).toEqual({ open: true, view: "steps" });
    expect(read("", detail("DEBUG", 1))).toEqual({ open: true, view: "diagnosis" });
    expect(read("", detail("GONOGO", 1))).toEqual({ open: true, view: "schematic" });
    expect(read("", detail("GONOGO", 1), false).open).toBe(false);
    expect(read("", detail("DESIGN")).open).toBe(false);
  });

  it("panel=off stays closed even on a roomy screen; junk values fall back to the defaults", () => {
    expect(read("panel=off&rev=1", detail("ASSEMBLE", 1))).toEqual({ open: false, view: "steps" });
    expect(read("panel=nope&rev=9&console=XYZ", detail("GONOGO", 2))).toEqual({ open: true, view: "schematic" });
    expect(read("panel=code&rev=0", detail("GONOGO", 2))).toEqual({ open: true, view: "code" });
    expect(read("panel=code&console=GUIDO", detail("GONOGO", 2))).toEqual({ open: true, view: "code" });
  });
});

describe("writePanel", () => {
  it("round-trips through the URL and keeps unrelated params", () => {
    const params = writePanel(new URLSearchParams("x=1&rev=5"), { open: true, view: "checks", revision: 2, console: "FAO" });
    expect(params.toString()).toBe("x=1&rev=2&panel=checks&console=FAO");
    expect(readPanel(params, detail("GONOGO", 2), true)).toEqual({ open: true, view: "checks", revision: 2, console: "FAO" });
  });

  it("closing drops the version and focus so a later open starts from the defaults", () => {
    expect(writePanel(new URLSearchParams("panel=code&rev=1&console=FAO"), { open: false, view: "code", revision: 1 }).toString()).toBe("panel=off");
  });
});
