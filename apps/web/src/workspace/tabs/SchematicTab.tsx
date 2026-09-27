import CloseIcon from "@mui/icons-material/Close";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { BOARD_PROFILES, MODULES, formatOhms, type Part, type RevisionDetail } from "@vibread/core";
import { useState, type MouseEvent } from "react";
import { useBuildState } from "../../api/hooks.js";
import { SvgArtifact } from "../../components/SvgArtifact.js";
import { WireColorPicker, WireLegend, useWireColor, type WireTarget } from "../WireColors.js";
import { MONO_FONT } from "../../theme.js";

function partDescription(part: Part): string {
  const mod = MODULES[part.module];
  const params = part.params ?? {};
  const bits: string[] = [];
  if (typeof params.color === "string") bits.push(params.color);
  if (typeof params.ohms === "number") bits.push(formatOhms(params.ohms));
  return `${part.label ? `${part.label}: ` : ""}${mod?.name ?? part.module}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

const ZOOMS = [
  { value: 0, label: "Fit" },
  { value: 1.5, label: "150%" },
  { value: 2, label: "200%" },
  { value: 3, label: "300%" },
] as const;

/**
 * The schematic full screen (IQA2-16d): fit to the window or zoomed 150–300 % with the page's own scrolling. Tapping a
 * net still opens the wire-colour picker when the drawing belongs to the build target.
 */
function SchematicDialog({ open, onClose, url, title, onTap, tappable }: { open: boolean; onClose(): void; url: string; title: string; onTap(event: MouseEvent<HTMLElement>): void; tappable: boolean }) {
  const [zoom, setZoom] = useState<number>(0);
  return (
    <Dialog fullScreen open={open} onClose={onClose} aria-labelledby="schematic-dialog-title">
      <Stack direction="row" sx={{ alignItems: "center", gap: 1.5, px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexWrap: "wrap" }}>
        <Typography id="schematic-dialog-title" variant="h6" component="h2" sx={{ flex: 1, minWidth: 160 }}>
          Schematic · {title}
        </Typography>
        {tappable && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Tap a wire to change its colour.
          </Typography>
        )}
        <ToggleButtonGroup size="small" exclusive value={zoom} onChange={(_, value: number | null) => value !== null && setZoom(value)} aria-label="Zoom">
          {ZOOMS.map((z) => (
            <ToggleButton key={z.value} value={z.value} sx={{ px: 1.5, minWidth: 56 }}>
              {z.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Tooltip title="Close">
          <IconButton aria-label="Close the enlarged schematic" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box
        onClick={onTap}
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          p: 2,
          bgcolor: "canvas.main",
          ...(tappable ? { "& g.net": { cursor: "pointer" } } : {}),
        }}
      >
        <SvgArtifact
          url={url}
          label={`Schematic of ${title}, enlarged`}
          sx={
            zoom === 0
              ? { height: "100%", "& svg": { width: "100%", height: "100%", maxHeight: "none" } }
              : { width: `${zoom * 100}%`, "& svg": { width: "100%", height: "auto", maxHeight: "none" } }
          }
        />
      </Box>
    </Dialog>
  );
}

export function SchematicTab({ missionId, revision, released }: { missionId: string; revision: RevisionDetail; released: boolean }) {
  const build = useBuildState(missionId, released);
  const wires = build.data?.revision === revision.n ? build.data.wires : undefined;
  const setWireColor = useWireColor(missionId, ["mission", missionId, "build"]);
  const [picker, setPicker] = useState<{ target: WireTarget; anchor: { top: number; left: number } } | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const onTap = (event: MouseEvent<HTMLElement>) => {
    if (!wires || !(event.target instanceof Element)) return;
    const net = event.target.closest("g.net[data-net]")?.getAttribute("data-net");
    if (net) setPicker({ target: { net }, anchor: { top: event.clientY, left: event.clientX } });
  };
  // The build target is drawn with the builder's wire colours; tapping a net recolours all its wires.
  const url = wires?.schematicUrl ?? revision.artifactUrls["schematic.svg"];
  const { circuit } = revision;
  return (
    <Stack sx={{ gap: 2 }}>
      <Box>
        <Typography variant="h6" component="h2">
          {circuit.title}
        </Typography>
        <Typography sx={{ color: "text.secondary" }}>{circuit.summary}</Typography>
      </Box>
      {url ? (
        <Box>
          <Paper variant="outlined" sx={{ position: "relative", p: 1, bgcolor: "canvas.main", ...(wires ? { "& g.net": { cursor: "pointer" } } : {}) }} onClick={onTap}>
            <Tooltip title="Enlarge the schematic">
              <IconButton
                aria-label="Enlarge the schematic"
                onClick={(event) => {
                  event.stopPropagation();
                  setEnlarged(true);
                }}
                sx={{ position: "absolute", top: 8, right: 8, zIndex: 1, bgcolor: "background.paper", border: 1, borderColor: "divider", "&:hover": { bgcolor: "background.paper" } }}
              >
                <OpenInFullIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <SvgArtifact url={url} label={`Schematic of ${circuit.title}${wires ? ". Tap a wire to change its colour." : ""}`} />
          </Paper>
          {/* Under the canvas, not on it: the canvas is dark in both themes and the legend uses the theme's text colours. */}
          <WireLegend wires={wires} />
        </Box>
      ) : (
        <Alert severity="info">The schematic drawing isn't ready for this design yet.</Alert>
      )}
      {url && <SchematicDialog open={enlarged} onClose={() => setEnlarged(false)} url={url} title={circuit.title} onTap={onTap} tappable={wires !== undefined} />}
      <WireColorPicker anchor={picker?.anchor ?? null} target={picker?.target ?? null} wires={wires} revision={revision.n} onClose={() => setPicker(null)} onPick={(request) => setWireColor.mutate(request)} />
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          What it should do
        </Typography>
        <List dense disablePadding>
          {circuit.intent.map((c) => (
            <ListItem key={c.id} disableGutters>
              <Chip size="small" label={c.id} variant="outlined" sx={{ mr: 1, fontFamily: MONO_FONT }} />
              <ListItemText primary={c.text} />
            </ListItem>
          ))}
        </List>
      </Box>
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          Parts ({circuit.parts.length}, plus the {BOARD_PROFILES[circuit.board.profile]?.name ?? circuit.board.profile})
        </Typography>
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: 0.5 }}>
          {circuit.parts.map((p) => (
            <Chip key={p.id} label={`${p.id} · ${partDescription(p)}`} variant="outlined" />
          ))}
        </Stack>
      </Box>
      {circuit.assumptions.length > 0 && (
        <Box>
          <Typography variant="overline" sx={{ color: "text.secondary" }}>
            Assumptions
          </Typography>
          <List dense disablePadding>
            {circuit.assumptions.map((a) => (
              <ListItem key={a} disableGutters>
                <ListItemText primary={a} />
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Stack>
  );
}
