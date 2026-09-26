import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import RemoveIcon from "@mui/icons-material/Remove";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import SettingsIcon from "@mui/icons-material/Settings";
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { LED_COLORS, MODE_LABELS, formatOhms, type InventoryItem, type ModuleKey, type ModuleSummary } from "@vibread/core";
import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useCreateMission, useMissions, useModules } from "../api/hooks.js";
import { agoLabel, useNow } from "../lib/time.js";
import { useDefaultMode } from "../lib/prefs.js";
import { MODE_HELP, ModeSelect } from "../workspace/ModeSelect.js";
import { PHASE_COPY } from "../workspace/PhaseDrawer.js";

const RESISTOR_OHMS = [100, 220, 330, 470, 1_000, 2_200, 4_700, 10_000, 100_000];
const POT_OHMS = [1_000, 10_000, 100_000];

interface Row {
  key: number;
  module: ModuleKey;
  name: string;
  count: number;
  params: Record<string, unknown>;
}

function defaultParams(module: ModuleKey): Record<string, unknown> {
  if (module === "led") return { color: "red" };
  if (module === "resistor") return { ohms: 220 };
  if (module === "potentiometer") return { ohms: 10_000 };
  return {};
}

function ParamPicker({ row, onChange }: { row: Row; onChange(params: Record<string, unknown>): void }) {
  if (row.module === "led") {
    return (
      <FormControl size="small" sx={{ minWidth: 120 }}>
        <InputLabel id={`color-${row.key}`}>Color</InputLabel>
        <Select labelId={`color-${row.key}`} label="Color" value={String(row.params.color ?? "red")} onChange={(e) => onChange({ color: e.target.value })}>
          {LED_COLORS.map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }
  if (row.module === "resistor" || row.module === "potentiometer") {
    const options = row.module === "resistor" ? RESISTOR_OHMS : POT_OHMS;
    return (
      <FormControl size="small" sx={{ minWidth: 120 }}>
        <InputLabel id={`ohms-${row.key}`}>Value</InputLabel>
        <Select labelId={`ohms-${row.key}`} label="Value" value={Number(row.params.ohms ?? options[0])} onChange={(e) => onChange({ ohms: Number(e.target.value) })}>
          {options.map((o) => (
            <MenuItem key={o} value={o}>
              {formatOhms(o)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }
  return null;
}

function PartsPicker({ modules, rows, setRows }: { modules: ModuleSummary[]; rows: Row[]; setRows(rows: Row[]): void }) {
  const [nextKey, setNextKey] = useState(1);
  const add = (m: ModuleSummary) => {
    setRows([...rows, { key: nextKey, module: m.key, name: m.name, count: 1, params: defaultParams(m.key) }]);
    setNextKey(nextKey + 1);
  };
  const update = (key: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <Box>
      <Typography variant="overline" component="h3" sx={{ color: "text.secondary" }}>
        Parts I have
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        Tap a part to add it. ViBread designs with only these parts (plus your Arduino and breadboard).
      </Typography>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        {modules.map((m) => (
          <Tooltip key={m.key} title={m.description} describeChild>
            <Chip icon={<AddIcon />} label={m.name} aria-label={`Add ${m.name}`} onClick={() => add(m)} variant="outlined" sx={{ minHeight: 32 }} />
          </Tooltip>
        ))}
      </Stack>
      {rows.length > 0 && (
        <Stack sx={{ gap: 1, mt: 2 }} component="ul" aria-label="Your parts" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((r) => (
            <Stack key={r.key} component="li" direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Typography sx={{ minWidth: 150, fontWeight: 600 }}>{r.name}</Typography>
              <Stack direction="row" sx={{ alignItems: "center" }}>
                <IconButton aria-label={`One fewer ${r.name}`} disabled={r.count <= 1} onClick={() => update(r.key, { count: r.count - 1 })}>
                  <RemoveIcon />
                </IconButton>
                <Typography sx={{ minWidth: 40, textAlign: "center" }} aria-label={`${r.count} ${r.name}`}>
                  × {r.count}
                </Typography>
                <IconButton aria-label={`One more ${r.name}`} onClick={() => update(r.key, { count: r.count + 1 })}>
                  <AddIcon />
                </IconButton>
              </Stack>
              <ParamPicker row={r} onChange={(params) => update(r.key, { params })} />
              <IconButton aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                <DeleteOutlineIcon />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const modules = useModules();
  const missions = useMissions();
  const create = useCreateMission();
  const [defaultMode] = useDefaultMode();
  const [mode, setMode] = useState(defaultMode);
  const [brief, setBrief] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const now = useNow(60_000);

  const start = () => {
    const inventory: InventoryItem[] = rows.map((r) => ({
      module: r.module,
      count: r.count,
      ...(Object.keys(r.params).length ? { params: r.params } : {}),
    }));
    create.mutate({ brief: brief.trim(), inventory, mode }, { onSuccess: (m) => navigate(`/m/${m.id}`) });
  };

  return (
    <Box sx={{ minHeight: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1 }}>
          <RocketLaunchIcon color="primary" />
          <Typography variant="h3" component="span" sx={{ fontWeight: 800 }}>
            ViBread
          </Typography>
          <Typography variant="overline" sx={{ color: "text.secondary", ml: 1, flex: 1 }}>
            Mission Control for your breadboard
          </Typography>
          <Button component={RouterLink} to="/settings" startIcon={<SettingsIcon />}>
            Settings &amp; connections
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Card component="section" aria-labelledby="new-mission-heading">
          <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2.5, p: 3 }}>
            <Box>
              <Typography id="new-mission-heading" variant="h1">
                What should your circuit do?
              </Typography>
              <Typography sx={{ color: "text.secondary", mt: 0.5 }}>
                Tell me what you want to make, in your own words. I'll check your parts first, test everything in a simulator, and
                show you how to build it step by step.
              </Typography>
            </Box>
            <TextField
              label="Describe your idea"
              placeholder="A lamp that turns on when it gets dark, and a button that cycles through moon phases on four LEDs."
              multiline
              minRows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              helperText="You can change the design as often as you like before anything goes onto your board."
              slotProps={{ htmlInput: { maxLength: 2000 } }}
            />
            {modules.isPending ? (
              <Skeleton variant="rounded" height={80} />
            ) : modules.isError ? (
              <Alert severity="error">Couldn't load the parts list: {modules.error.message}</Alert>
            ) : (
              <PartsPicker modules={modules.data} rows={rows} setRows={setRows} />
            )}
            <Stack direction="row" sx={{ gap: 2, alignItems: "center", flexWrap: "wrap" }}>
              <ModeSelect id="new-mission-mode" value={mode} onChange={setMode} size="medium" />
              <Typography variant="body2" sx={{ color: "text.secondary", flex: 1, minWidth: 200 }}>
                {MODE_HELP[mode]} Anything that touches the board always waits for you.
              </Typography>
            </Stack>
            {create.isError && <Alert severity="error">Couldn't start the mission: {create.error.message}</Alert>}
            <Box>
              <Button variant="contained" size="large" startIcon={<RocketLaunchIcon />} disabled={!brief.trim() || create.isPending} onClick={start}>
                {create.isPending ? "Starting…" : "Start the mission"}
              </Button>
            </Box>
          </CardContent>
        </Card>

        <Box component="section" aria-labelledby="recent-heading" sx={{ mt: 4 }}>
          <Typography id="recent-heading" variant="h2" sx={{ mb: 1 }}>
            Recent missions
          </Typography>
          {missions.isPending ? (
            <Skeleton variant="rounded" height={120} />
          ) : missions.isError ? (
            <Alert severity="error">Couldn't load your missions: {missions.error.message}</Alert>
          ) : missions.data.length === 0 ? (
            <Typography sx={{ color: "text.secondary" }}>No missions yet. Your first one will show up here.</Typography>
          ) : (
            <Card>
              <List disablePadding>
                {[...missions.data]
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((m) => (
                    <ListItemButton key={m.id} component={RouterLink} to={`/m/${m.id}`} divider sx={{ gap: 2 }}>
                      <ListItemText
                        primary={m.title}
                        secondary={`${PHASE_COPY[m.phase].label} · ${MODE_LABELS[m.mode]} mode · updated ${agoLabel(m.updatedAt, now)}`}
                        slotProps={{ primary: { sx: { fontWeight: 600 } } }}
                      />
                      {m.releasedRevision !== undefined && <Chip size="small" label={`Building r${m.releasedRevision}`} variant="outlined" />}
                      <Typography sx={{ color: "primary.main", fontWeight: 600 }}>Open</Typography>
                    </ListItemButton>
                  ))}
              </List>
            </Card>
          )}
        </Box>
      </Container>
    </Box>
  );
}
