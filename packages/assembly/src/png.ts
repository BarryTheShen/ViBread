import { Resvg } from "@resvg/resvg-js";

/** Render a static ViBread SVG using system fonts so labels survive PNG export. */
export async function svgToPng(svg: string, width = 1200): Promise<Uint8Array> {
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      loadSystemFonts: true,
      sansSerifFamily: "DejaVu Sans",
      defaultFontFamily: "DejaVu Sans",
    },
    textRendering: 2,
    shapeRendering: 2,
  });
  const png = renderer.render().asPng();
  return new Uint8Array(png);
}
