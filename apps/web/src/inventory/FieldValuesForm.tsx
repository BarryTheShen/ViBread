import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import type { FieldValue, PartField } from "@vibread/core";
import { parseFieldValue } from "./forms.js";

export interface FieldValuesFormProps {
  fields: PartField[];
  values: Record<string, FieldValue>;
  onChange(values: Record<string, FieldValue>): void;
  disabled?: boolean;
  compact?: boolean;
}

/** Render a choice's unit wherever the option is shown, while preserving its raw stored value. */
export function choiceOptionLabel(field: PartField, option: string): string {
  return `${option}${field.unit ? ` ${field.unit}` : ""}`;
}

/** Explain package/appearance fields without implying they change the circuit. */
export function fieldHelperText(field: PartField): string | undefined {
  if (field.electrical) return undefined;
  if (field.kind === "choice" && field.options?.length) {
    const common = field.options.find((option) => option === "5") ?? field.options[0];
    return `${field.label} — ${choiceOptionLabel(field, common)} is the most common; doesn't change the circuit`;
  }
  return `${field.label} doesn't change the circuit`;
}

export function FieldValuesForm({ fields, values, onChange, disabled = false, compact = false }: FieldValuesFormProps) {
  if (fields.length === 0) {
    return <FormLabel sx={{ color: "text.secondary" }}>This type has no fields.</FormLabel>;
  }
  return (
    <Stack spacing={compact ? 1 : 2}>
      {fields.map((field) => {
        const value = values[field.key];
        const id = `part-field-${field.key}`;
        const helper = fieldHelperText(field);
        if (field.kind === "boolean") {
          return (
            <FormControl key={field.key} disabled={disabled}>
              <FormControlLabel
                control={
                  <Switch
                    id={id}
                    checked={Boolean(value)}
                    onChange={(event) => onChange({ ...values, [field.key]: parseFieldValue(field, event.target.checked) })}
                  />
                }
                label={field.label}
              />
              {helper ? <FormHelperText>{helper}</FormHelperText> : null}
            </FormControl>
          );
        }
        if (field.kind === "choice") {
          const options = field.options ?? [];
          return (
            <FormControl key={field.key} fullWidth size={compact ? "small" : "medium"} disabled={disabled} required={field.required}>
              <InputLabel id={`${id}-label`}>{field.label}</InputLabel>
              <Select
                labelId={`${id}-label`}
                id={id}
                label={field.label}
                value={String(value ?? "")}
                onChange={(event) => onChange({ ...values, [field.key]: parseFieldValue(field, String(event.target.value)) })}
              >
                {options.length === 0 ? <MenuItem value="">No values yet</MenuItem> : null}
                {options.map((option) => (
                  <MenuItem key={option} value={option}>
                    {choiceOptionLabel(field, option)}
                  </MenuItem>
                ))}
              </Select>
              {helper ? <FormHelperText>{helper}</FormHelperText> : null}
            </FormControl>
          );
        }
        return (
          <TextField
            key={field.key}
            id={id}
            label={field.label}
            value={value ?? ""}
            required={field.required}
            disabled={disabled}
            fullWidth
            size={compact ? "small" : "medium"}
            type={field.kind === "number" ? "number" : "text"}
            helperText={helper}
            slotProps={{
              input: field.unit ? { endAdornment: <InputAdornment position="end">{field.unit}</InputAdornment> } : undefined,
              htmlInput: {
                ...(field.kind === "number" && field.min !== undefined ? { min: field.min } : {}),
                ...(field.kind === "number" && field.max !== undefined ? { max: field.max } : {}),
              },
            }}
            onChange={(event) => onChange({ ...values, [field.key]: parseFieldValue(field, event.target.value) })}
          />
        );
      })}
    </Stack>
  );
}

export function QuantityStepper({ quantity, onChange, disabled = false }: { quantity: number; onChange(quantity: number): void; disabled?: boolean }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }} aria-label="Quantity">
      <IconButtonWithLabel label="Decrease quantity" disabled={disabled || quantity <= 0} onClick={() => onChange(Math.max(0, quantity - 1))}>
        <RemoveIcon fontSize="small" />
      </IconButtonWithLabel>
      <TextField
        aria-label="Quantity"
        value={quantity}
        disabled={disabled}
        size="small"
        type="number"
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.max(0, Math.trunc(next)));
        }}
        slotProps={{ htmlInput: { min: 0, inputMode: "numeric", style: { width: 44, textAlign: "center" } } }}
        sx={{ "& .MuiOutlinedInput-root": { px: 0 } }}
      />
      <IconButtonWithLabel label="Increase quantity" disabled={disabled} onClick={() => onChange(quantity + 1)}>
        <AddIcon fontSize="small" />
      </IconButtonWithLabel>
    </Stack>
  );
}

function IconButtonWithLabel({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <IconButton aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </IconButton>
  );
}
