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
});
