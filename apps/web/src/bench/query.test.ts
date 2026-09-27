import { describe, expect, it } from "vitest";
import { parseBenchQuery } from "./query.js";

describe("parseBenchQuery", () => {
  it("keeps valid tests and only accepts mission-local return paths", () => {
    expect(parseBenchQuery("?tests=net.continuity,button.interactive,wat&returnTo=%2Fm%2Fabc%3Fpanel%3Dsteps")).toEqual({
      tests: ["net.continuity", "button.interactive"],
      returnTo: "/m/abc?panel=steps",
    });
    expect(parseBenchQuery("?tests=led.sequence&returnTo=https%3A%2F%2Fevil.example")).toEqual({ tests: ["led.sequence"] });
  });

  it("keeps the build step that opened the bench, and ignores anything that isn't a step number", () => {
    expect(parseBenchQuery("?tests=rails.vcc&step=3").step).toBe(3);
    for (const bad of ["0", "-2", "2.5", "x", ""]) expect(parseBenchQuery(`?tests=rails.vcc&step=${bad}`).step).toBeUndefined();
  });
});
