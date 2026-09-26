import HistoryIcon from "@mui/icons-material/History";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";

/** Marks anything replayed from a recorded real-model run, so it is never mistaken for a live result. */
export function RecordedChip({ label, title, onLight = false }: { label: string; title?: string; onLight?: boolean }) {
  const chip = (
    <Chip
      size="small"
      variant={onLight ? "filled" : "outlined"}
      color={onLight ? "primary" : "info"}
      icon={<HistoryIcon />}
      label={label}
      tabIndex={title ? 0 : undefined}
    />
  );
  return title ? (
    <Tooltip title={title} describeChild>
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}
