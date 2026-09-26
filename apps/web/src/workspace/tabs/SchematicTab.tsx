import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { BOARD_PROFILES, MODULES, formatOhms, type Part, type RevisionDetail } from "@vibread/core";
import { useState } from "react";
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

export function SchematicTab({ missionId, revision, released }: { missionId: string; revision: RevisionDetail; released: boolean }) {
  const build = useBuildState(missionId, released);
  const wires = build.data?.revision === revision.n ? build.data.wires : undefined;
  const setWireColor = useWireColor(missionId, ["mission", missionId, "build"]);
  const [picker, setPicker] = useState<{ target: WireTarget; anchor: { top: number; left: number } } | null>(null);
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
        <Paper
          variant="outlined"
          sx={{ p: 1, bgcolor: "canvas.main", ...(wires ? { "& g.net": { cursor: "pointer" } } : {}) }}
          onClick={(event) => {
            if (!wires) return;
            const net = (event.target as Element).closest("g.net[data-net]")?.getAttribute("data-net");
            if (net) setPicker({ target: { net }, anchor: { top: event.clientY, left: event.clientX } });
          }}
        >
          <SvgArtifact url={url} label={`Schematic of ${circuit.title}${wires ? ". Tap a wire to change its colour." : ""}`} />
          <WireLegend wires={wires} />
        </Paper>
      ) : (
        <Alert severity="info">The schematic drawing isn't ready for this design yet.</Alert>
      )}
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
