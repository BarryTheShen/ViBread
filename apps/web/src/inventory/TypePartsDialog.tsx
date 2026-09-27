import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { inventoryIdentity, type CatalogView, type FieldValue, type InventoryEntry, type ParsedPartLine } from "@vibread/core";
import { useEffect, useState } from "react";
import { useInventory, useParseInventory, useUpsertInventory } from "../api/inventory.js";
import { FieldValuesForm } from "./FieldValuesForm.js";
import { reviewQuantityLabel, valuesForFields } from "./forms.js";

export interface TypePartsDialogProps {
  open: boolean;
  catalog: CatalogView | undefined;
  onClose(): void;
  onSaved(): void;
}

type EditableLine = ParsedPartLine & { id: number; existing?: InventoryEntry; mode: "add" | "replace" };

function valuesComplete(type: CatalogView["types"][number] | undefined, values: Record<string, FieldValue>): boolean {
  if (!type) return false;
  return type.fields.every((field) => !field.required || (values[field.key] !== undefined && values[field.key] !== ""));
}

export function TypePartsDialog({ open, catalog, onClose, onSaved }: TypePartsDialogProps) {
  const inventory = useInventory();
  const parse = useParseInventory();
  const save = useUpsertInventory();
  const [text, setText] = useState("");
  const [lines, setLines] = useState<EditableLine[]>([]);

  useEffect(() => {
    if (!open) {
      parse.reset();
      save.reset();
      setLines([]);
    }
  }, [open]);

  const existingFor = (typeId: string | null, values: Record<string, FieldValue>): InventoryEntry | undefined => {
    const type = catalog?.types.find((candidate) => candidate.id === typeId);
    if (!type) return undefined;
    const identity = inventoryIdentity(type, values);
    return inventory.data?.entries.find((entry) => entry.typeId === type.id && inventoryIdentity(type, entry.values) === identity);
  };

  const statusFor = (typeId: string | null, values: Record<string, FieldValue>, candidates?: EditableLine["candidates"]): EditableLine["status"] => {
    const type = catalog?.types.find((candidate) => candidate.id === typeId);
    if (!type) return "unknown";
    return valuesComplete(type, values) && !(candidates && candidates.length > 0) ? "ready" : "needs-look";
  };

  const runParse = () => {
    if (!text.trim()) return;
    parse.mutate(text, {
      onSuccess: (response) =>
        setLines(response.lines.map((line, id) => {
          const existing = existingFor(line.typeId, line.values);
          return { ...line, id, existing, mode: existing ? "replace" : "add" };
        })),
    });
  };

  const updateLine = (id: number, patch: Partial<EditableLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const updateValues = (line: EditableLine, values: Record<string, FieldValue>) => {
    const existing = existingFor(line.typeId, values);
    updateLine(line.id, { values, status: statusFor(line.typeId, values, line.candidates), existing, mode: existing ? line.mode : "add" });
  };

  const chooseType = (line: EditableLine, typeId: string) => {
    const type = catalog?.types.find((candidate) => candidate.id === typeId);
    const values = valuesForFields(type?.fields ?? [], line.values);
    const existing = existingFor(typeId, values);
    updateLine(line.id, { typeId, values, existing, mode: existing ? "replace" : "add", status: statusFor(typeId, values) });
  };

  const saveLines = () => {
    const unknownCount = lines.filter((line) => !line.typeId).length;
    if (unknownCount > 0) return;
    const valid = lines.filter((line) => line.typeId && line.quantity > 0);
    save.mutate(
      {
        items: valid.map((line) => ({
          typeId: line.typeId as string,
          values: line.values,
          quantity: Math.max(1, Math.trunc(line.quantity)),
          mode: line.mode,
          source: "typed" as const,
          ...(line.status === "needs-look" ? { status: "needs-look" as const, candidates: line.candidates } : {}),
        })),
      },
      {
        onSuccess: () => {
          setText("");
          setLines([]);
          onSaved();
        },
      },
    );
  };
  const unknownCount = lines.filter((line) => !line.typeId).length;


  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="type-parts-title">
      <DialogTitle id="type-parts-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Type parts
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography color="text.secondary">Try “6 red LEDs, 10 × 220 ohm resistors, 1 push button”. Nothing is saved until you review the rows.</Typography>
          <TextField multiline minRows={4} value={text} onChange={(event) => setText(event.target.value)} label="Parts I have" placeholder={"3 red LEDs\n10 × 220 Ω resistors"} fullWidth />
          <Button variant="outlined" onClick={runParse} disabled={!text.trim() || parse.isPending} startIcon={parse.isPending ? <CircularProgress size={16} /> : undefined}>{parse.isPending ? "Reading…" : "Read this list"}</Button>
          {parse.error ? <Alert severity="error">{parse.error instanceof Error ? parse.error.message : "Could not read this list."}</Alert> : null}
          {lines.length > 0 ? (
            <Stack spacing={1.5}>
              <Typography variant="h3">Review {lines.length} part{lines.length === 1 ? "" : "s"}</Typography>
              {lines.map((line) => {
                const type = catalog?.types.find((candidate) => candidate.id === line.typeId);
                const matching = catalog?.types ?? [];
                return (
                  <Box key={line.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
                      <Typography sx={{ flex: 1 }} color="text.secondary">{line.text}</Typography>
                      <FormControl size="small" sx={{ minWidth: 210 }}>
                        <InputLabel id={`typed-type-${line.id}`}>Part type</InputLabel>
                        <Select labelId={`typed-type-${line.id}`} label="Part type" value={line.typeId ?? ""} onChange={(event) => chooseType(line, event.target.value)}>
                          <MenuItem value="">Choose a type</MenuItem>
                          {matching.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <TextField size="small" label="Count" type="number" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })} slotProps={{ htmlInput: { min: 0 } }} sx={{ width: 100 }} />
                      {line.existing ? (
                        <>
                          <ToggleButtonGroup size="small" exclusive value={line.mode} onChange={(_, mode: "add" | "replace" | null) => mode && updateLine(line.id, { mode })} aria-label="Add or replace">
                            <ToggleButton value="replace">Replace</ToggleButton>
                            <ToggleButton value="add">Add</ToggleButton>
                          </ToggleButtonGroup>
                          <Typography variant="caption" color="text.secondary">{reviewQuantityLabel(line.existing.quantity, line.quantity, line.mode)}</Typography>
                        </>
                      ) : null}
                      <IconButton aria-label={`Remove ${line.text}`} color="error" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}><DeleteOutlineOutlinedIcon /></IconButton>
                    </Stack>
                    {type ? <Box sx={{ mt: 1.5 }}><FieldValuesForm fields={type.fields} values={line.values} onChange={(values: Record<string, FieldValue>) => updateValues(line, values)} compact /></Box> : null}
                    {line.status === "needs-look" ? <Alert severity="warning" sx={{ mt: 1 }}>Fill the highlighted values before adding this part.</Alert> : null}
                  </Box>
                );
              })}
            </Stack>
          ) : null}
          {unknownCount > 0 ? <Alert severity="warning">{unknownCount === 1 ? "1 row still needs" : `${unknownCount} rows still need`} a part type. Choose a type or remove the row before saving.</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={saveLines} disabled={unknownCount > 0 || lines.length === 0 || lines.every((line) => !line.typeId || line.quantity <= 0) || save.isPending}>{save.isPending ? "Saving…" : "Add these parts"}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default TypePartsDialog;
