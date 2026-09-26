import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import Chip from "@mui/material/Chip";
import type { ComposerProps } from "../contracts.js";
import { useInventory } from "../api/inventory.js";
import { useMemo } from "react";

export interface PartsChipProps {
  count?: number;
  label?: string;
  onClick(): void;
}

export function PartsChip({ count, label, onClick }: PartsChipProps) {
  const inventory = useInventory();
  const fetchedCount = useMemo(() => inventory.data?.entries.reduce((total, entry) => total + entry.quantity, 0), [inventory.data?.entries]);
  const resolvedCount = count ?? fetchedCount;
  const text = label ?? `Parts: all inventory${resolvedCount === undefined ? "" : ` (${resolvedCount})`}`;
  return <Chip clickable icon={<Inventory2OutlinedIcon />} label={text} onClick={onClick} variant="outlined" aria-label={text} />;
}

/** Adapter for ComposerProps.parts, useful when the parent already owns the label. */
export function ComposerPartsChip({ parts }: Pick<ComposerProps, "parts">) {
  if (!parts) return null;
  return <PartsChip label={parts.label} onClick={parts.onClick} />;
}

export default PartsChip;
