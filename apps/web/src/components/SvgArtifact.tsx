import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import type { SxProps, Theme } from "@mui/material/styles";
import { forwardRef, useMemo } from "react";
import { useArtifactText } from "../api/hooks.js";
import { sanitizeSvg } from "../lib/svg.js";

/** Fetches an SVG artifact, sanitizes it, and inlines it so parts can be highlighted/animated by id. */
export const SvgArtifact = forwardRef<HTMLDivElement, { url: string; label: string; sx?: SxProps<Theme> }>(function SvgArtifact(
  { url, label, sx },
  ref,
) {
  const svg = useArtifactText(url);
  const html = useMemo(() => {
    if (!svg.data) return { ok: false as const, error: null };
    try {
      return { ok: true as const, markup: sanitizeSvg(svg.data) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [svg.data]);

  if (svg.isPending) return <Skeleton variant="rounded" height={320} aria-label={`Loading ${label}`} />;
  if (svg.isError) return <Alert severity="error">Couldn't load {label}: {svg.error.message}</Alert>;
  if (!html.ok) return <Alert severity="error">{html.error ?? `Couldn't show ${label}.`}</Alert>;
  return (
    <Box
      ref={ref}
      role="img"
      aria-label={label}
      sx={[{ "& svg": { display: "block", width: "100%", height: "auto", maxHeight: "70vh" } }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
      dangerouslySetInnerHTML={{ __html: html.markup }}
    />
  );
});
