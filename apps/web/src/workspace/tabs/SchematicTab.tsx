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
import { SvgArtifact } from "../../components/SvgArtifact.js";

function partDescription(part: Part): string {
  const mod = MODULES[part.module];
  const params = part.params ?? {};
  const bits: string[] = [];
  if (typeof params.color === "string") bits.push(params.color);
  if (typeof params.ohms === "number") bits.push(formatOhms(params.ohms));
  return `${part.label ? `${part.label}: ` : ""}${mod?.name ?? part.module}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

export function SchematicTab({ revision }: { revision: RevisionDetail }) {
  const url = revision.artifactUrls["schematic.svg"];
  const { circuit } = revision;
  return (
    <Stack sx={{ gap: 2 }}>
      <Box>
        <Typography variant="h3" component="h2">
          {circuit.title}
        </Typography>
        <Typography sx={{ color: "text.secondary" }}>{circuit.summary}</Typography>
      </Box>
      {url ? (
        <Paper variant="outlined" sx={{ p: 1, bgcolor: "#0a0f14" }}>
          <SvgArtifact url={url} label={`Schematic of ${circuit.title}`} />
        </Paper>
      ) : (
        <Alert severity="info">The schematic drawing isn't ready for this design yet.</Alert>
      )}
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          What it should do
        </Typography>
        <List dense disablePadding>
          {circuit.intent.map((c) => (
            <ListItem key={c.id} disableGutters>
              <Chip size="small" label={c.id} variant="outlined" sx={{ mr: 1, fontFamily: "monospace" }} />
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
