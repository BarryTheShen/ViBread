import { describe, expect, it } from "vitest";
import { scrollForCentre, viewCentre } from "./zoomScroll.js";

describe("zoomed step picture scrolling", () => {
  it("opens on the middle of the picture instead of its top-left corner", () => {
    expect(scrollForCentre({ x: 0.5, y: 0.5 }, { scrollWidth: 780, scrollHeight: 1000, clientWidth: 390, clientHeight: 700 })).toEqual({ left: 195, top: 150 });
  });

  it("keeps the spot in the middle of the screen in the middle when zooming from 2× to 3×", () => {
    // At 2× (780 px wide) the viewer has scrolled to the right half: the middle of the screen is at 585 px = 75 %.
    const centre = viewCentre({ scrollLeft: 390, scrollTop: 0, scrollWidth: 780, scrollHeight: 600, clientWidth: 390, clientHeight: 600 });
    expect(centre).toEqual({ x: 0.75, y: 0.5 });
    // At 3× (1170 px) 75 % is 877.5 px, so the screen starts 195 px before it.
    expect(scrollForCentre(centre, { scrollWidth: 1170, scrollHeight: 900, clientWidth: 390, clientHeight: 600 })).toEqual({ left: 682.5, top: 150 });
  });

  it("never scrolls past the picture's edges, and a picture smaller than the screen stays unscrolled", () => {
    expect(scrollForCentre({ x: 1, y: 0 }, { scrollWidth: 1560, scrollHeight: 1200, clientWidth: 390, clientHeight: 700 })).toEqual({ left: 1170, top: 0 });
    expect(scrollForCentre({ x: 0.9, y: 0.9 }, { scrollWidth: 390, scrollHeight: 300, clientWidth: 390, clientHeight: 700 })).toEqual({ left: 0, top: 0 });
    expect(viewCentre({ scrollLeft: 0, scrollTop: 0, scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });
});
