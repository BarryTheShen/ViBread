import { createTheme, type Theme } from "@mui/material/styles";
import type {} from "@mui/x-chat/themeAugmentation";

/**
 * "Mission Control" dark theme: near-black blue-gray consoles, light-blue primary, high-contrast text, status colors
 * that always travel with a text label and an icon (never color alone).
 */
export const MONO_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Visible keyboard focus on the dark theme: 2 px amber ring (≈ 11:1 against the canvas). */
const FOCUS_RING = { outline: "2px solid #fbbf24", outlineOffset: 2 } as const;

export function createMissionTheme(reducedMotion: boolean): Theme {
  const theme = createTheme({
    palette: {
      mode: "dark",
      primary: { main: "#7dd3fc", contrastText: "#04121c" },
      secondary: { main: "#fbbf24", contrastText: "#1a1204" },
      success: { main: "#4ade80", contrastText: "#03170a" },
      warning: { main: "#fbbf24", contrastText: "#1a1204" },
      error: { main: "#f87171", contrastText: "#1f0505" },
      info: { main: "#93c5fd", contrastText: "#04121c" },
      background: { default: "#070b10", paper: "#0f1720" },
      text: { primary: "#eef4fa", secondary: "#b7c4d1", disabled: "#7f8d9b" },
      divider: "rgba(148, 170, 196, 0.22)",
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: 'Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize: 15,
      h1: { fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.01em" },
      h2: { fontSize: "1.5rem", fontWeight: 700 },
      h3: { fontSize: "1.2rem", fontWeight: 600 },
      overline: { fontFamily: MONO_FONT, letterSpacing: "0.14em", fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 600 },
    },
    transitions: reducedMotion ? { create: () => "none" } : undefined,
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundImage: "radial-gradient(ellipse at top, #0e1a26 0%, #070b10 60%)", minHeight: "100vh" },
          code: { fontFamily: MONO_FONT },
          "*:focus-visible": { outline: "3px solid #fbbf24", outlineOffset: 2 },
          ...(reducedMotion
            ? { "*, *::before, *::after": { animationDuration: "0.001ms !important", transitionDuration: "0.001ms !important" } }
            : {}),
        },
      },
      // ButtonBase covers Button, IconButton, Tab, clickable Chip, Checkbox/Radio (SwitchBase) and ListItemButton.
      // MUI resets `outline: 0` on these, so the global rule alone never shows: add a 2 px high-contrast ring.
      MuiButtonBase: { defaultProps: { disableRipple: reducedMotion }, styleOverrides: { root: { "&.Mui-focusVisible": FOCUS_RING } } },
      MuiButton: { styleOverrides: { root: { minHeight: 36 } } },
      MuiIconButton: { styleOverrides: { root: { minWidth: 36, minHeight: 36 } } },
      MuiChip: { styleOverrides: { root: { minHeight: 28, fontWeight: 500, "&.Mui-focusVisible": FOCUS_RING } } },
      MuiTab: { styleOverrides: { root: { minHeight: 44, textTransform: "none", fontWeight: 600, "&.Mui-focusVisible": { ...FOCUS_RING, outlineOffset: -3 } } } },
      MuiLink: { styleOverrides: { root: { "&:focus-visible": { ...FOCUS_RING, borderRadius: 2 } } } },
      MuiOutlinedInput: { styleOverrides: { root: { "&.Mui-focused": { outline: "2px solid #fbbf24", outlineOffset: 2 } } } },
      MuiSlider: { styleOverrides: { thumb: { "&.Mui-focusVisible": { ...FOCUS_RING, boxShadow: "none" } } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiCard: { styleOverrides: { root: { border: "1px solid rgba(148, 170, 196, 0.22)" } } },
      MuiAppBar: {
        styleOverrides: { root: { backgroundColor: "#0b1118", borderBottom: "1px solid rgba(148, 170, 196, 0.22)" } },
        defaultProps: { elevation: 0, color: "default" },
      },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: "0.85rem", backgroundColor: "#1d2a37", color: "#eef4fa" } } },
    },
  });
  return theme;
}
