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
import Typography from "@mui/material/Typography";
import type { CatalogView, FieldValue, ParsedPartLine } from "@vibread/core";
import { useEffect, useState } from "react";
import { useParseInventory, useUpsertInventory } from "../api/inventory.js";
import { FieldValuesForm } from "./FieldValuesForm.js";
import { valuesForFields } from "./forms.js";

export interface TypePartsDialogProps {
  open: boolean;
  catalog: CatalogView | undefined;
  onClose(): void;
  onSaved(): void;
}

type EditableLine = ParsedPartLine & { id: number };

export function TypePartsDialog({ open, catalog, onClose, onSaved }: TypePartsDialogProps) {
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

  const runParse = () => {
    if (!text.trim()) return;
    parse.mutate(text, { onSuccess: (response) => setLines(response.lines.map((line, id) => ({ ...line, id }))) });
  };

  const updateLine = (id: number, patch: Partial<EditableLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const chooseType = (line: EditableLine, typeId: string) => {
    const type = catalog?.types.find((candidate) => candidate.id === typeId);
    updateLine(line.id, { typeId, values: valuesForFields(type?.fields ?? [], line.values), status: type ? "ready" : "unknown" });
  };

  const saveLines = () => {
    const valid = lines.filter((line) => line.typeId && line.quantity > 0);
    save.mutate(
      {
        items: valid.map((line) => ({
          typeId: line.typeId as string,
          values: line.values,
          quantity: Math.max(1, Math.trunc(line.quantity)),
          mode: "add" as const,
          source: "typed" as const,
          ...(line.status === "needs-look" ? { status: "needs-look" as const, candidates: line.candidates } : {}),
        })),
      },
      { onSuccess: onSaved },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="type-parts-title">
      <DialogTitle id="type-parts-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Type parts
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography color="text.secondary">Try “6 red LEDs, 10 × 220 ohm resistors, 1 push button”. Nothing is saved until you review the rows.</Typography>
          <TextField multiline minRows={4} value={text} onChange={(event) => setText(event.target.value)} label="Parts I have" placeholder="3 red LEDs\n10 × 220 Ω resistors" fullWidth />
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
                      <IconButton aria-label={`Remove ${line.text}`} color="error" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}><DeleteOutlineOutlinedIcon /></IconButton>
                    </Stack>
                    {type ? <Box sx={{ mt: 1.5 }}><FieldValuesForm fields={type.fields} values={line.values} onChange={(values: Record<string, FieldValue>) => updateLine(line.id, { values })} compact /></Box> : null}
                    {line.status === "needs-look" ? <Alert severity="warning" sx={{ mt: 1 }}>This value needs a look before it can be used in a design.</Alert> : null}
                  </Box>
                );
              })}
            </Stack>
          ) : null}
          {save.error ? <Alert severity="error">{save.error instanceof Error ? save.error.message : "Could not save these parts."}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={saveLines} disabled={lines.length === 0 || lines.every((line) => !line.typeId || line.quantity <= 0) || save.isPending}>{save.isPending ? "Saving…" : "Add these parts"}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default TypePartsDialog;
