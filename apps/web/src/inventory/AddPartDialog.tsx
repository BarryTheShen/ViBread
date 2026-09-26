import CloseIcon from "@mui/icons-material/Close";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { CatalogView, FieldValue, InventoryEntry, PartType } from "@vibread/core";
import { useEffect, useMemo, useState } from "react";
import { FieldValuesForm } from "./FieldValuesForm.js";
import { valuesForFields } from "./forms.js";

export interface AddPartDialogProps {
  open: boolean;
  catalog: CatalogView | undefined;
  entry?: InventoryEntry;
  onClose(): void;
  onSave(input: { typeId: string; values: Record<string, FieldValue>; quantity: number; mode: "add" | "replace" }): void;
}

export function AddPartDialog({ open, catalog, entry, onClose, onSave }: AddPartDialogProps) {
  const [typeId, setTypeId] = useState("");
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!open) return;
    const initialType = entry?.typeId ?? catalog?.types[0]?.id ?? "";
    const type = catalog?.types.find((candidate) => candidate.id === initialType);
    setTypeId(initialType);
    setSearch("");
    setValues(valuesForFields(type?.fields ?? [], entry?.values));
    setQuantity(entry?.quantity ?? 1);
  }, [open, entry, catalog]);

  const type = catalog?.types.find((candidate) => candidate.id === typeId);
  const filteredTypes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return catalog?.types ?? [];
    return (catalog?.types ?? []).filter((candidate) => `${candidate.name} ${candidate.aliases.join(" ")}`.toLocaleLowerCase().includes(query));
  }, [catalog?.types, search]);

  const chooseType = (nextTypeId: string) => {
    setTypeId(nextTypeId);
    const next = catalog?.types.find((candidate) => candidate.id === nextTypeId);
    setValues(valuesForFields(next?.fields ?? []));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="add-part-title">
      <DialogTitle id="add-part-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {entry ? "Edit part" : "Add a part"}
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <TextField label="Search catalog" placeholder="LED, resistor, button…" value={search} onChange={(event) => setSearch(event.target.value)} fullWidth />
          <FormControl fullWidth required>
            <InputLabel id="add-part-type-label">Part type</InputLabel>
            <Select labelId="add-part-type-label" label="Part type" value={typeId} onChange={(event) => chooseType(event.target.value)}>
              {filteredTypes.length === 0 ? <MenuItem value="">No matching types</MenuItem> : null}
              {filteredTypes.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}{candidate.builtIn ? "" : " · yours"}</MenuItem>)}
            </Select>
          </FormControl>
          {type ? (
            <>
              <Typography variant="body2" color="text.secondary">{type.description}</Typography>
              <FieldValuesForm fields={type.fields} values={values} onChange={setValues} />
              <TextField label="Quantity" type="number" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.trunc(Number(event.target.value) || 1)))} slotProps={{ htmlInput: { min: 1 } }} fullWidth />
            </>
          ) : <Typography color="text.secondary">Choose a type to enter its details.</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!type || quantity < 1} onClick={() => type && onSave({ typeId: type.id, values, quantity, mode: entry ? "replace" : "add" })}>{entry ? "Save changes" : "Add part"}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default AddPartDialog;
