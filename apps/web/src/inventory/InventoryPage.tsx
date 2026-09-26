import AddIcon from "@mui/icons-material/Add";
import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import TextFieldsOutlinedIcon from "@mui/icons-material/TextFieldsOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import OutlinedInput from "@mui/material/OutlinedInput";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { EntryStatus, InventoryEntry, PartCategory, PartType, ScanItem, SupportLevel } from "@vibread/core";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
  useCatalog,
  useDeleteInventoryItem,
  useInventory,
  usePatchInventoryItem,
  useUpsertInventory,
} from "../api/inventory.js";
import { AddPartDialog } from "./AddPartDialog.js";
import { PartTypeEditor } from "./PartTypeEditor.js";
import { QuantityStepper } from "./FieldValuesForm.js";
import { ScanDialog } from "./ScanDialog.js";
import { TypePartsDialog } from "./TypePartsDialog.js";
import { formatEntryLabel } from "./forms.js";

const FILTERS = ["all", "ready", "needs-look", "in-use", "not-usable"] as const;
type Filter = (typeof FILTERS)[number];

const CATEGORY_LABELS: Record<PartCategory, string> = {
  lights: "Lights",
  resistors: "Resistors",
  switches: "Switches",
  sensors: "Sensors",
  sound: "Sound",
  displays: "Displays",
  motors: "Motors",
  semiconductors: "Semiconductors",
  passives: "Passives",
  modules: "Modules",
  board: "Board",
  supplies: "Supplies",
  other: "Other",
};

const SUPPORT_LABELS: Record<SupportLevel, string> = {
  full: "Ready to use",
  modelled: "Modelled",
  basic: "Basic",
  "list-only": "List only",
  supply: "Supply",
};

interface InventoryRow extends InventoryEntry {
  usedIn: Array<{ missionId: string; title: string }>;
}

function statusChip(entry: InventoryRow, type: PartType | undefined) {
  if (entry.status === "needs-look") return { label: "Needs a look", color: "warning" as const };
  if (!type) return { label: "Needs a look", color: "warning" as const };
  if (type.support === "modelled") {
    const module = type.mapping.kind === "modelled" ? type.mapping.module : "part";
    return { label: `Modelled as ${module}`, color: "info" as const };
  }
  if (type.support === "basic") return { label: "Basic · your pins", color: "info" as const };
  if (type.support === "list-only") return { label: "List only", color: "default" as const };
  return { label: SUPPORT_LABELS[type.support], color: "success" as const };
}

function categoryOf(type: PartType | undefined): PartCategory {
  return type?.category ?? "other";
}

function sourceFromScan(item: ScanItem): PartType {
  return {
    id: `scan-${item.index}`,
    name: item.label || "Unknown scanned part",
    category: "other",
    aliases: [],
    photoHint: item.label || "Part from a scan",
    description: item.label || "A part identified from a scan.",
    fields: [],
    support: "list-only",
    mapping: { kind: "note" },
    builtIn: false,
  };
}

function filterLabel(filter: Filter): string {
  if (filter === "all") return "All";
  if (filter === "ready") return "Ready";
  if (filter === "needs-look") return "Needs a look";
  if (filter === "in-use") return "In use";
  return "Not usable in designs";
}
function compareInventoryEntries(a: InventoryRow, b: InventoryRow, typeById: Map<string, PartType>): number {
  const aType = typeById.get(a.typeId);
  const bType = typeById.get(b.typeId);
  const typeOrder = (aType?.name ?? a.typeId).localeCompare(bType?.name ?? b.typeId);
  if (typeOrder !== 0) return typeOrder;
  const numericField = (type: PartType | undefined, entry: InventoryRow): number | undefined => {
    const field = type?.fields.find((candidate) => candidate.kind === "number" && typeof entry.values[candidate.key] === "number");
    const value = field ? entry.values[field.key] : undefined;
    return typeof value === "number" ? value : undefined;
  };
  const aNumber = numericField(aType, a);
  const bNumber = numericField(bType, b);
  if (aNumber !== undefined && bNumber !== undefined && aNumber !== bNumber) return aNumber - bNumber;
  return formatEntryLabel(aType, a.values).localeCompare(formatEntryLabel(bType, b.values));
}

export default function InventoryPage() {
  const catalog = useCatalog();
  const inventory = useInventory();
  const patch = usePatchInventoryItem();
  const remove = useDeleteInventoryItem();
  const add = useUpsertInventory();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [typePartsOpen, setTypePartsOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);
  const [sourceType, setSourceType] = useState<PartType | undefined>();
  const [editing, setEditing] = useState<InventoryRow | undefined>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; entry: InventoryRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InventoryRow | null>(null);

  const types = catalog.data?.types ?? [];
  const typeById = useMemo(() => new Map(types.map((type) => [type.id, type])), [types]);
  const rows = inventory.data?.entries ?? [];
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return rows.filter((entry) => {
      const type = typeById.get(entry.typeId);
      const text = `${type?.name ?? "Unknown"} ${type?.aliases.join(" ") ?? ""} ${Object.values(entry.values).join(" ")}`.toLocaleLowerCase();
      if (query && !text.includes(query)) return false;
      if (filter === "ready" && entry.status !== "ready") return false;
      if (filter === "needs-look" && entry.status !== "needs-look") return false;
      if (filter === "in-use" && entry.usedIn.length === 0) return false;
      if (filter === "not-usable" && !["list-only", "supply"].includes(type?.support ?? "list-only")) return false;
      return true;
    });
  }, [filter, rows, search, typeById]);
  const grouped = useMemo(() => {
    const groups: Partial<Record<PartCategory, InventoryRow[]>> = {};
    for (const entry of filtered) {
      const category = categoryOf(typeById.get(entry.typeId));
      (groups[category] ??= []).push(entry);
    }
    return (Object.keys(groups) as PartCategory[]).sort((a, b) => CATEGORY_LABELS[a].localeCompare(CATEGORY_LABELS[b])).map((category) => ({ category, entries: (groups[category] ?? []).sort((a, b) => compareInventoryEntries(a, b, typeById)) }));
  }, [filtered, typeById]);

  const openEditorFromScan = (item: ScanItem) => {
    setSourceType(sourceFromScan(item));
    setTypeEditorOpen(true);
  };
  const savePart = (input: { typeId: string; values: Record<string, string | number | boolean>; quantity: number; mode: "add" | "replace" }) => {
    if (editing) {
      patch.mutate({ id: editing.id, patch: { typeId: input.typeId, values: input.values, quantity: input.quantity, status: "ready" } }, { onSuccess: () => { setEditing(undefined); setAddOpen(false); } });
      return;
    }
    add.mutate({ items: [{ ...input, source: "manual" }] }, { onSuccess: () => setAddOpen(false) });
  };
  const chooseCandidate = (entry: InventoryRow, value: string) => {
    try {
      const values = JSON.parse(value) as Record<string, string | number | boolean>;
      patch.mutate({ id: entry.id, patch: { values, status: "ready" } });
    } catch {
      // Select values are generated by JSON.stringify; leave the row unchanged if a browser extension alters it.
    }
  };

  if (inventory.isLoading || catalog.isLoading) {
    return <Container maxWidth="lg" sx={{ py: 4 }}><Stack spacing={2}><Typography variant="h1">Inventory</Typography><CircularProgress aria-label="Loading inventory" /></Stack></Container>;
  }
  if (inventory.error || catalog.error) {
    const error = inventory.error ?? catalog.error;
    return <Container maxWidth="lg" sx={{ py: 4 }}><Alert severity="error">{error instanceof Error ? error.message : "Could not load your inventory."}</Alert></Container>;
  }

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, md: 4 } }}>
      <Box sx={{ position: "sticky", top: 0, zIndex: 2, bgcolor: "background.default", pt: { xs: 0, md: 0.5 }, pb: 1 }}>
        <Stack spacing={2.5}>
          <Stack direction={{ xs: "column", md: "row" }} sx={{ alignItems: { md: "center" }, justifyContent: "space-between" }} spacing={2}>
            <Box>
              <Typography variant="h1">Inventory · {total} part{total === 1 ? "" : "s"}</Typography>
              <Typography color="text.secondary">Your shared parts library, ready for every mission.</Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              <Button variant="outlined" startIcon={<CameraAltOutlinedIcon />} onClick={() => setScanOpen(true)}>Scan parts</Button>
              <Button variant="outlined" startIcon={<TextFieldsOutlinedIcon />} onClick={() => setTypePartsOpen(true)}>Type parts</Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setEditing(undefined); setAddOpen(true); }}>Add part</Button>
              <Button variant="text" startIcon={<BuildOutlinedIcon />} onClick={() => { setSourceType(undefined); setTypeEditorOpen(true); }}>New part type</Button>
            </Stack>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <OutlinedInput fullWidth placeholder="Search inventory…" value={search} onChange={(event) => setSearch(event.target.value)} startAdornment={<InputAdornment position="start">⌕</InputAdornment>} inputProps={{ "aria-label": "Search inventory" }} />
          </Stack>
          <Tabs value={filter} onChange={(_, value: Filter) => setFilter(value)} variant="scrollable" allowScrollButtonsMobile aria-label="Inventory filters">
            {FILTERS.map((value) => <Tab key={value} value={value} label={filterLabel(value)} />)}
          </Tabs>
        </Stack>
      </Box>
      <Stack spacing={2.5}>
        {rows.length === 0 ? (
          <Card><CardContent><Stack spacing={1.5} sx={{ alignItems: "flex-start" }}><Typography variant="h2">Your inventory is empty</Typography><Typography color="text.secondary">Scan a pile of parts or type a quick list. You can also add one part at a time.</Typography><Stack direction="row" spacing={1}><Button variant="contained" startIcon={<CameraAltOutlinedIcon />} onClick={() => setScanOpen(true)}>Scan your parts</Button><Button variant="outlined" onClick={() => setTypePartsOpen(true)}>Type parts</Button></Stack></Stack></CardContent></Card>
        ) : grouped.length === 0 ? (
          <Alert severity="info">No inventory rows match this search or filter.</Alert>
        ) : (
          <Stack spacing={3}>
            {grouped.map(({ category, entries }) => (
              <Box key={category} component="section" aria-labelledby={`inventory-${category}`}>
                <Typography id={`inventory-${category}`} variant="overline" color="text.secondary">{CATEGORY_LABELS[category]}</Typography>
                <Card sx={{ mt: 0.75 }}>
                  {entries.map((entry, index) => {
                    const type = typeById.get(entry.typeId);
                    const chip = statusChip(entry, type);
                    return (
                      <Box key={entry.id}>
                        {index > 0 ? <Divider /> : null}
                        <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ p: { xs: 1.5, md: 2 }, alignItems: { md: "center" } }}>
                          <Box sx={{ flex: 1, minWidth: 220 }}>
                            <Typography sx={{ fontWeight: 600 }}>{formatEntryLabel(type, entry.values)}</Typography>
                            {type ? <Typography variant="body2" color="text.secondary">{type.description}</Typography> : null}
                            {entry.note ? <Typography variant="caption" color="text.secondary">{entry.note}</Typography> : null}
                          </Box>
                          <QuantityStepper quantity={entry.quantity} onChange={(quantity) => patch.mutate({ id: entry.id, patch: { quantity } })} disabled={patch.isPending} />
                          <Chip size="small" label={chip.label} color={chip.color} variant={chip.color === "default" ? "outlined" : "filled"} />
                          <Box sx={{ minWidth: 160, flex: 1 }}>
                            {entry.status === "needs-look" && entry.candidates?.length ? (
                              <TextField select size="small" fullWidth label="Choose a value" value={JSON.stringify(entry.values)} onChange={(event) => chooseCandidate(entry, event.target.value)}>
                                {entry.candidates.map((candidate, candidateIndex) => <MenuItem key={candidateIndex} value={JSON.stringify(candidate)}>{type ? formatEntryLabel(type, candidate) : JSON.stringify(candidate)}</MenuItem>)}
                              </TextField>
                            ) : entry.usedIn.length > 0 ? (
                              <Typography variant="body2" color="text.secondary">Used in {entry.usedIn.map((mission) => <RouterLink key={mission.missionId} to={`/m/${encodeURIComponent(mission.missionId)}`} style={{ marginLeft: 4 }}>{mission.title}</RouterLink>)}</Typography>
                            ) : <Typography variant="body2" color="text.secondary">Not used yet</Typography>}
                          </Box>
                          <IconButton aria-label={`More actions for ${formatEntryLabel(type, entry.values)}`} onClick={(event) => setMenu({ anchor: event.currentTarget, entry })}><MoreHorizIcon /></IconButton>
                        </Stack>
                      </Box>
                    );
                  })}
                </Card>
              </Box>
            ))}
          </Stack>
        )}
      </Stack>

      <Menu open={Boolean(menu)} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => { if (menu) setEditing(menu.entry); setMenu(null); setAddOpen(true); }}><EditOutlinedIcon fontSize="small" sx={{ mr: 1 }} />Edit fields</MenuItem>
        <MenuItem onClick={() => { if (menu) setEditing(menu.entry); setMenu(null); setAddOpen(true); }}>Change type</MenuItem>
        <MenuItem onClick={() => { if (menu) setPendingDelete(menu.entry); setMenu(null); }} sx={{ color: "error.main" }}><DeleteOutlineOutlinedIcon fontSize="small" sx={{ mr: 1 }} />Delete</MenuItem>
      </Menu>
      <Dialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} aria-labelledby="delete-inventory-title">
        <DialogTitle id="delete-inventory-title">Delete this inventory entry?</DialogTitle>
        <DialogContent><Typography color="text.secondary">This removes {pendingDelete ? formatEntryLabel(typeById.get(pendingDelete.typeId), pendingDelete.values) : "this part"} from your shared inventory.</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => { if (pendingDelete) remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) }); }}>Delete</Button>
        </DialogActions>
      </Dialog>
      <AddPartDialog open={addOpen} catalog={catalog.data} entry={editing} onClose={() => { setAddOpen(false); setEditing(undefined); }} onSave={savePart} />
      <TypePartsDialog open={typePartsOpen} catalog={catalog.data} onClose={() => setTypePartsOpen(false)} onSaved={() => setTypePartsOpen(false)} />
      <PartTypeEditor open={typeEditorOpen} catalog={catalog.data} source={sourceType} onClose={() => { setTypeEditorOpen(false); setSourceType(undefined); }} onSaved={() => { setTypeEditorOpen(false); setSourceType(undefined); }} />
      <ScanDialog open={scanOpen} catalog={catalog.data} onClose={() => setScanOpen(false)} onTypeParts={() => { setScanOpen(false); setTypePartsOpen(true); }} onCreateType={openEditorFromScan} />
    </Container>
  );
}
