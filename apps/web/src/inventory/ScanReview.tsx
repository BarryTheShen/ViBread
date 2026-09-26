import AddCircleOutlineOutlinedIcon from "@mui/icons-material/AddCircleOutlineOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import HelpOutlineOutlinedIcon from "@mui/icons-material/HelpOutlineOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
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
import type { CatalogView, FieldValue, ScanAcceptRequest, ScanItem, ScanView } from "@vibread/core";
import { useEffect, useMemo, useState } from "react";
import { scanCropUrl } from "../api/inventory.js";
import { FieldValuesForm } from "./FieldValuesForm.js";
import { formatEntryLabel, reviewQuantityLabel, scanItemToUpsert, valuesForFields } from "./forms.js";

interface ReviewRow {
  item: ScanItem;
  typeId: string;
  values: Record<string, FieldValue>;
  quantity: number;
  mode: "add" | "replace";
  included: boolean;
}

export interface ScanReviewProps {
  scan: ScanView;
  catalog: CatalogView | undefined;
  onAccept(request: ScanAcceptRequest): void;
  onCreateType(item: ScanItem): void;
  phone?: boolean;
}

function initialRows(scan: ScanView, catalog: CatalogView | undefined): ReviewRow[] {
  return scan.items.map((item) => {
    const type = catalog?.types.find((candidate) => candidate.id === item.typeId);
    return {
      item,
      typeId: item.typeId ?? "",
      values: valuesForFields(type?.fields ?? [], item.values),
      quantity: item.quantity,
      mode: item.existing ? "replace" : "add",
      included: true,
    };
  });
}

export function ScanReview({ scan, catalog, onAccept, onCreateType, phone = false }: ScanReviewProps) {
  const [rows, setRows] = useState<ReviewRow[]>(() => initialRows(scan, catalog));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setRows(initialRows(scan, catalog));
    setSubmitted(false);
  }, [scan.id, scan.items, catalog?.types]);

  const typeById = useMemo(() => new Map((catalog?.types ?? []).map((type) => [type.id, type])), [catalog?.types]);
  const updateRow = (index: number, patch: Partial<ReviewRow>) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));

  const submit = () => {
    const items = rows
      .filter((row) => row.included && row.typeId && row.quantity > 0)
      .map((row) => scanItemToUpsert({ ...row.item, values: row.values, quantity: row.quantity }, row.typeId, row.mode));
    if (items.length === 0) return;
    setSubmitted(true);
    onAccept({ items });
  };

  if (scan.status === "failed") return <Alert severity="error">{scan.error || "This scan failed. Try another photo or Type parts instead."}</Alert>;
  if (scan.items.length === 0) return <Alert severity="info">No parts were found in this scan. You can Type parts instead or try a clearer photo.</Alert>;

  return (
    <Stack spacing={2}>
      <Typography variant={phone ? "h2" : "h3"}>Check the list</Typography>
      <Typography color="text.secondary">Review each crop before adding it. Counts are estimates and may be off.</Typography>
      {rows.map((row, index) => {
        const item = row.item;
        const type = typeById.get(row.typeId);
        const crop = item.cropUrl || scanCropUrl(scan.id, item.index);
        const candidateType = type;
        return (
          <Box key={item.index} sx={{ border: 1, borderColor: row.included ? "divider" : "action.disabled", borderRadius: 2, p: { xs: 1.5, sm: 2 }, opacity: row.included ? 1 : 0.65 }}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <Box sx={{ width: phone ? "100%" : 150, flexShrink: 0 }}>
                <Box component="img" src={crop} alt={`Scan crop: ${item.label}`} sx={{ display: "block", width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 1, bgcolor: "action.hover" }} />
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>{item.label}</Typography>
              </Box>
              <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  <Chip size="small" color={item.status === "ready" ? "success" : item.status === "needs-look" ? "warning" : "default"} icon={item.status === "unknown" ? <HelpOutlineOutlinedIcon /> : undefined} label={item.status === "needs-look" ? "Needs a look" : item.status === "ready" ? "Ready" : "Unknown"} />
                  <IconButton aria-label={`Remove ${item.label}`} onClick={() => updateRow(index, { included: !row.included })} color={row.included ? "error" : "success"}>
                    {row.included ? <DeleteOutlineOutlinedIcon /> : <AddCircleOutlineOutlinedIcon />}
                  </IconButton>
                </Stack>
                <FormControl fullWidth size="small">
                  <InputLabel id={`scan-type-${scan.id}-${item.index}`}>Matched type</InputLabel>
                  <Select
                    labelId={`scan-type-${scan.id}-${item.index}`}
                    label="Matched type"
                    value={row.typeId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      const nextType = typeById.get(nextId);
                      updateRow(index, { typeId: nextId, values: valuesForFields(nextType?.fields ?? [], row.values) });
                    }}
                  >
                    <MenuItem value="">Choose a type</MenuItem>
                    {(catalog?.types ?? []).map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}</MenuItem>)}
                  </Select>
                </FormControl>
                {type ? <FieldValuesForm fields={type.fields} values={row.values} onChange={(values) => updateRow(index, { values })} compact /> : null}
                {!type ? <Button size="small" variant="outlined" onClick={() => onCreateType(item)}>Create a type from this</Button> : null}
                {item.candidates && item.candidates.length > 0 ? (
                  <FormControl size="small" fullWidth>
                    <InputLabel id={`scan-candidate-${scan.id}-${item.index}`}>Candidate value</InputLabel>
                    <Select
                      labelId={`scan-candidate-${scan.id}-${item.index}`}
                      label="Candidate value"
                      value={JSON.stringify(row.values)}
                      onChange={(event) => updateRow(index, { values: JSON.parse(event.target.value) as Record<string, FieldValue> })}
                    >
                      {item.candidates.map((candidate, candidateIndex) => <MenuItem key={candidateIndex} value={JSON.stringify(candidate)}>{candidateType ? formatEntryLabel(candidateType, candidate) : JSON.stringify(candidate)}</MenuItem>)}
                    </Select>
                  </FormControl>
                ) : null}
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
                  <TextField label="Count" type="number" value={row.quantity} onChange={(event) => updateRow(index, { quantity: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })} size="small" slotProps={{ htmlInput: { min: 1 } }} sx={{ width: phone ? "100%" : 120 }} />
                  {item.existing ? (
                    <>
                      <ToggleButtonGroup size="small" exclusive value={row.mode} onChange={(_, mode: "add" | "replace" | null) => mode && updateRow(index, { mode })} aria-label="Add or replace">
                        <ToggleButton value="replace">Replace</ToggleButton>
                        <ToggleButton value="add">Add</ToggleButton>
                      </ToggleButtonGroup>
                      <Typography variant="caption" color="text.secondary">{reviewQuantityLabel(item.existing.quantity, row.quantity, row.mode)}</Typography>
                    </>
                  ) : null}
                </Stack>
                {item.status === "needs-look" ? <Alert severity="warning">The model saw more than one likely value. Pick the one that matches your part.</Alert> : null}
              </Stack>
            </Stack>
          </Box>
        );
      })}
      {submitted ? <Alert severity="success">Added to your inventory.</Alert> : null}
      <Button variant="contained" onClick={submit} disabled={submitted || rows.every((row) => !row.included || !row.typeId || row.quantity <= 0)}>
        {submitted ? "Saved" : `Add ${rows.filter((row) => row.included && row.typeId).length} to inventory`}
      </Button>
    </Stack>
  );
}

export default ScanReview;
