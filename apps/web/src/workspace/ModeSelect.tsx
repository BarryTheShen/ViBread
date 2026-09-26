import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import { MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "@vibread/core";

/** One-line explanations of the permission modes (PLAN §5.10), in beginner language. */
export const MODE_HELP: Record<PermissionMode, string> = {
  plan: "Talks it through and proposes. Changes nothing until you switch modes.",
  ask: "Asks you before every change to the design or code.",
  review: "Changes the design freely; asks you once before a design becomes the build target.",
  autopilot: "Picks the build target on its own when every check says GO.",
};

export const PHYSICAL_NOTE = "In every mode, anything that touches the board waits for you at the bench.";

export function ModeSelect({
  value,
  onChange,
  disabled,
  id = "mode-select",
  label = "Permission mode",
  size = "small",
}: {
  value: PermissionMode;
  onChange(mode: PermissionMode): void;
  disabled?: boolean;
  id?: string;
  label?: string;
  size?: "small" | "medium";
}) {
  return (
    <FormControl size={size} sx={{ minWidth: 210 }} disabled={disabled}>
      <InputLabel id={`${id}-label`}>{label}</InputLabel>
      <Select
        labelId={`${id}-label`}
        id={id}
        value={value}
        label={label}
        onChange={(e) => onChange(e.target.value as PermissionMode)}
        renderValue={(v) => MODE_LABELS[v]}
        MenuProps={{ slotProps: { paper: { sx: { maxWidth: 420 } } } }}
      >
        {PERMISSION_MODES.map((mode) => (
          <MenuItem key={mode} value={mode} sx={{ whiteSpace: "normal", alignItems: "flex-start", py: 1 }}>
            <ListItemText
              primary={`${MODE_LABELS[mode]}${mode === "review" ? " (default)" : ""}`}
              secondary={MODE_HELP[mode]}
              slotProps={{ secondary: { sx: { color: "text.secondary" } } }}
            />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
