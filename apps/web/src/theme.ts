import { createTheme, type Theme } from "@mui/material/styles";
import type { CSSProperties } from "react";

declare module "@mui/material/styles" {
  interface TypographyVariants {
    reply: CSSProperties;
  }

  interface TypographyVariantsOptions {
    reply?: CSSProperties;
  }

  interface TypeBackground {
    sidebar: string;
  }

  interface Palette {
    canvas: Palette["primary"];
    code: Palette["primary"];
    input: Palette["primary"];
    link: Palette["primary"];
    qr: Palette["primary"];
  }

  interface PaletteOptions {
    canvas?: PaletteOptions["primary"];
    code?: PaletteOptions["primary"];
    input?: PaletteOptions["primary"];
    link?: PaletteOptions["primary"];
    qr?: PaletteOptions["primary"];
  }
}

declare module "@mui/material/Typography" {
  interface TypographyPropsVariantOverrides {
    reply: true;
  }
}

/**
 * Coolors space-cadet/crimson palette. Keep all UI colours here so feature slices use the shared palette instead of
 * copying brand literals into their own components.
 */
export const THEME_TOKENS = {
  light: {
    main: "#EDF2F4",
    sidebar: "#E2E8EC",
    cards: "#FFFFFF",
    text: "#2B2D42",
    secondaryText: "#5C677D",
    primary: "#2B2D42",
    primaryText: "#FFFFFF",
    link: "#2B2D42",
    accent: "#D80032",
    accentText: "#FFFFFF",
    success: "#1F7A4D",
    info: "#2B2D42",
    warning: "#9A4A06",
    warningText: "#FFFFFF",
    error: "#D80032",
    inputBorder: "#6B7890",
    divider: "#D5DCE3",
    canvas: "#1B1D2B",
    code: "#E2E8EC",
    qr: "#FFFFFF",
  },
  dark: {
    main: "#1F2133",
    sidebar: "#25273A",
    cards: "#2B2D42",
    text: "#EDF2F4",
    secondaryText: "#A9B3C4",
    primary: "#EDF2F4",
    primaryText: "#2B2D42",
    link: "#EDF2F4",
    accent: "#D80032",
    accentText: "#FFFFFF",
    success: "#5FD39A",
    info: "#A9B3C4",
    warning: "#FBBF24",
    warningText: "#2B2D42",
    error: "#FF6B7D",
    inputBorder: "#8D99AE",
    divider: "#3A3D56",
    canvas: "#1B1D2B",
    code: "#1B1D2B",
    qr: "#FFFFFF",
  },
} as const;

export const MONO_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
// "@fontsource-variable/inter" registers the family as "Inter Variable"; plain "Inter" never matches it.
export const INTER_FONT = '"Inter Variable", Inter, "Helvetica Neue", Arial, sans-serif';
export const LORA_FONT = 'Lora, Georgia, "Times New Roman", serif';

const focusRing = {
  outline: "3px solid var(--mui-palette-primary-main)",
  outlineOffset: 2,
} as const;

const lightPalette = {
  mode: "light" as const,
  contrastThreshold: 4.5,
  primary: { main: THEME_TOKENS.light.primary, contrastText: THEME_TOKENS.light.primaryText },
  link: { main: THEME_TOKENS.light.link },
  secondary: { main: THEME_TOKENS.light.accent, contrastText: THEME_TOKENS.light.accentText },
  success: { main: THEME_TOKENS.light.success, contrastText: THEME_TOKENS.light.primaryText },
  info: { main: THEME_TOKENS.light.info, contrastText: THEME_TOKENS.light.primaryText },
  warning: { main: THEME_TOKENS.light.warning, contrastText: THEME_TOKENS.light.warningText },
  error: { main: THEME_TOKENS.light.error, contrastText: THEME_TOKENS.light.primaryText },
  background: { default: THEME_TOKENS.light.main, paper: THEME_TOKENS.light.cards, sidebar: THEME_TOKENS.light.sidebar },
  text: { primary: THEME_TOKENS.light.text, secondary: THEME_TOKENS.light.secondaryText },
  divider: THEME_TOKENS.light.divider,
  canvas: { main: THEME_TOKENS.light.canvas },
  code: { main: THEME_TOKENS.light.code },
  qr: { main: THEME_TOKENS.light.qr },
  input: { main: THEME_TOKENS.light.inputBorder },
};

const darkPalette = {
  mode: "dark" as const,
  contrastThreshold: 4.5,
  primary: { main: THEME_TOKENS.dark.primary, contrastText: THEME_TOKENS.dark.primaryText },
  link: { main: THEME_TOKENS.dark.link },
  secondary: { main: THEME_TOKENS.dark.accent, contrastText: THEME_TOKENS.dark.accentText },
  success: { main: THEME_TOKENS.dark.success, contrastText: THEME_TOKENS.dark.primaryText },
  info: { main: THEME_TOKENS.dark.info, contrastText: THEME_TOKENS.dark.primaryText },
  warning: { main: THEME_TOKENS.dark.warning, contrastText: THEME_TOKENS.dark.primaryText },
  error: { main: THEME_TOKENS.dark.error, contrastText: THEME_TOKENS.dark.primaryText },
  background: { default: THEME_TOKENS.dark.main, paper: THEME_TOKENS.dark.cards, sidebar: THEME_TOKENS.dark.sidebar },
  text: { primary: THEME_TOKENS.dark.text, secondary: THEME_TOKENS.dark.secondaryText },
  divider: THEME_TOKENS.dark.divider,
  canvas: { main: THEME_TOKENS.dark.canvas },
  code: { main: THEME_TOKENS.dark.code },
  qr: { main: THEME_TOKENS.dark.qr },
  input: { main: THEME_TOKENS.dark.inputBorder },
};

/**
 * Coolors blue/red/orange, border-led ViBread theme. MUI's colorSchemes keeps the two palettes in one theme and
 * ThemeProvider's default system mode follows prefers-color-scheme until the user chooses Light or Dark in Settings.
 */
export function createMissionTheme(reducedMotion: boolean): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: "data" },
    colorSchemes: {
      light: { palette: lightPalette },
      dark: { palette: darkPalette },
    },
    typography: {
      fontFamily: INTER_FONT,
      fontSize: 15,
      h1: { fontSize: "2rem", fontWeight: 600, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.015em" },
      h3: { fontSize: "1.2rem", fontWeight: 600 },
      h4: { fontSize: "1.1rem", fontWeight: 600 },
      h5: { fontSize: "1rem", fontWeight: 600 },
      h6: { fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 600 },
      overline: { fontFamily: MONO_FONT, letterSpacing: "0.08em", fontWeight: 600 },
      reply: { fontFamily: LORA_FONT, fontSize: "1.05rem", lineHeight: 1.7 },
    },
    shape: { borderRadius: 8 },
    transitions: reducedMotion ? { create: () => "none" } : undefined,
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            minHeight: "100vh",
            backgroundColor: "var(--mui-palette-background-default)",
            color: "var(--mui-palette-text-primary)",
          },
          code: { fontFamily: MONO_FONT },
          "*:focus-visible": focusRing,
          ...(reducedMotion
            ? { "*, *::before, *::after": { animationDuration: "0.001ms !important", transitionDuration: "0.001ms !important" } }
            : {}),
        },
      },
      // MUI resets ButtonBase's outline, so restore a visible input-token focus ring on every keyboard-focusable control.
      MuiButtonBase: { defaultProps: { disableRipple: reducedMotion }, styleOverrides: { root: { "&.Mui-focusVisible": focusRing } } },
      MuiButton: {
        styleOverrides: {
          root: { minHeight: 40, borderRadius: 8, textTransform: "none", "&:focus-visible": focusRing },
        },
      },
      MuiIconButton: { styleOverrides: { root: { minWidth: 40, minHeight: 40, borderRadius: 8, "&:focus-visible": focusRing } } },
      MuiTextField: { defaultProps: { variant: "outlined" }, styleOverrides: { root: { "& .MuiInputBase-root": { borderRadius: 8 } } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            "& .MuiOutlinedInput-notchedOutline": { borderColor: "var(--mui-palette-input-main)" },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: "var(--mui-palette-input-main)" },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: "var(--mui-palette-primary-main)", borderWidth: 2 },
          },
        },
      },
      MuiChip: { styleOverrides: { root: { minHeight: 30, borderRadius: 8, fontWeight: 600, "&.Mui-focusVisible": focusRing } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 44, borderBottom: "1px solid var(--mui-palette-divider)" } } },
      MuiTab: {
        styleOverrides: {
          root: { minHeight: 44, textTransform: "none", fontWeight: 600, "&.Mui-focusVisible": { ...focusRing, outlineOffset: -3 } },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: "var(--mui-palette-background-sidebar)",
            borderRight: "1px solid var(--mui-palette-divider)",
            backgroundImage: "none",
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: { border: "1px solid var(--mui-palette-divider)", borderRadius: 12, backgroundImage: "none" },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: "var(--mui-palette-text-primary)",
            color: "var(--mui-palette-background-default)",
            border: "1px solid var(--mui-palette-divider)",
            fontSize: "0.8rem",
          },
          arrow: { color: "var(--mui-palette-text-primary)" },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { border: "1px solid var(--mui-palette-divider)", borderRadius: 8 },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { border: "1px solid var(--mui-palette-divider)", borderRadius: 12, backgroundImage: "none" } },
      },
      MuiCard: { styleOverrides: { root: { border: "1px solid var(--mui-palette-divider)", borderRadius: 12 } } },
      MuiLink: {
        styleOverrides: {
          root: { color: "var(--mui-palette-link-main)", "&:focus-visible": { ...focusRing, borderRadius: 2 } },
        },
      },
    },
  });
}
