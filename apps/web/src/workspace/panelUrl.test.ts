import type { MissionDetail, MissionPhase } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { autoOpenedPanel, benchPanelPath, canonicalPanelParams, readPanel, writePanel } from "./panelUrl.js";

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
    expect(read("", detail("DEBUG", 1))).toEqual({ open: true, view: "results" });
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

describe("issue #24 panel views", () => {
  it("old panel ids open the view that replaced them, and the URL is rewritten to the new id", () => {
    expect(read("panel=replay&rev=1", detail("GONOGO", 2))).toEqual({ open: true, view: "tests", revision: 1 });
    expect(read("panel=telemetry", detail("VERIFY", 1)).view).toBe("results");
    expect(read("panel=diagnosis", detail("DEBUG", 1)).view).toBe("results");
    expect(canonicalPanelParams(new URLSearchParams("panel=replay&rev=1"))?.toString()).toBe("panel=tests&rev=1");
    expect(canonicalPanelParams(new URLSearchParams("panel=tests"))).toBeUndefined();
    expect(canonicalPanelParams(new URLSearchParams("panel=nope"))).toBeUndefined();
  });

  it("the old bench page URL becomes the mission page with the bench in the panel, keeping the checkpoint scope", () => {
    expect(benchPanelPath("m 1", "?tests=rails.vcc,led.sequence&step=6&returnTo=%2Fm%2Fm1%3Fpanel%3Dsteps&junk=1")).toBe(
      "/m/m%201?panel=bench&tests=rails.vcc%2Cled.sequence&step=6&returnTo=%2Fm%2Fm1%3Fpanel%3Dsteps",
    );
    expect(benchPanelPath("m1", "")).toBe("/m/m1?panel=bench");
    expect(read("panel=bench&tests=rails.vcc", detail("ASSEMBLE", 1))).toEqual({ open: true, view: "bench" });
  });

  it("a failing bench run never switches an open bench to Bench results; other views and a closed panel do switch", () => {
    const bench = { open: true, view: "bench", console: undefined } as const;
    expect(autoOpenedPanel(bench, "results")).toBe(bench);
    expect(autoOpenedPanel(bench, "steps")).toBe(bench);
    expect(autoOpenedPanel({ open: true, view: "steps" }, "results")).toEqual({ open: true, view: "results" });
    expect(autoOpenedPanel({ open: false, view: "bench" }, "results")).toEqual({ open: true, view: "results" });
  });

  it("the bench's checkpoint scope is dropped when leaving the bench", () => {
    const params = new URLSearchParams("panel=bench&tests=rails.vcc&step=3&returnTo=%2Fm%2Fx");
    expect(writePanel(params, { open: true, view: "bench" }).get("step")).toBe("3");
    expect(writePanel(params, { open: true, view: "steps" }).toString()).toBe("panel=steps");
    expect(writePanel(params, { open: false, view: "bench" }).toString()).toBe("panel=off");
  });
});
