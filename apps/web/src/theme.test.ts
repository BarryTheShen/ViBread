import { describe, expect, it } from "vitest";
import { THEME_TOKENS } from "./theme.js";

/** WCAG 2.2 relative luminance contrast ratio for two sRGB hex colours. */
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const value = hex.replace(/^#/, "");
    const rgb = (value.length === 3 ? value.split("").map((channel) => channel + channel) : value.match(/.{2}/g) ?? []).map(
      (channel) => Number.parseInt(channel, 16) / 255,
    );
    const linear = rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("ViBread theme contrast tokens", () => {
  it("keeps text pairs at WCAG AA contrast", () => {
    const pairs = [
      [THEME_TOKENS.light.text, THEME_TOKENS.light.main],
      [THEME_TOKENS.light.secondaryText, THEME_TOKENS.light.main],
      [THEME_TOKENS.light.primaryText, THEME_TOKENS.light.primary],
      [THEME_TOKENS.dark.text, THEME_TOKENS.dark.main],
      [THEME_TOKENS.dark.secondaryText, THEME_TOKENS.dark.main],
      [THEME_TOKENS.dark.primaryText, THEME_TOKENS.dark.primary],
      [THEME_TOKENS.dark.link, THEME_TOKENS.dark.main],
      [THEME_TOKENS.light.primaryText, THEME_TOKENS.light.success],
      [THEME_TOKENS.light.primaryText, THEME_TOKENS.light.info],
      [THEME_TOKENS.light.primaryText, THEME_TOKENS.light.warning],
      [THEME_TOKENS.light.primaryText, THEME_TOKENS.light.error],
      [THEME_TOKENS.dark.primaryText, THEME_TOKENS.dark.success],
      [THEME_TOKENS.dark.primaryText, THEME_TOKENS.dark.info],
      [THEME_TOKENS.dark.primaryText, THEME_TOKENS.dark.warning],
      [THEME_TOKENS.dark.primaryText, THEME_TOKENS.dark.error],
    ] as const;
    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps input borders and focus controls distinguishable", () => {
    const uiPairs = [
      [THEME_TOKENS.light.inputBorder, THEME_TOKENS.light.main],
      [THEME_TOKENS.dark.inputBorder, THEME_TOKENS.dark.main],
      [THEME_TOKENS.light.primary, THEME_TOKENS.light.main],
      [THEME_TOKENS.dark.primary, THEME_TOKENS.dark.main],
    ] as const;
    for (const [foreground, background] of uiPairs) {
      expect(contrastRatio(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(3);
    }
  });
});
