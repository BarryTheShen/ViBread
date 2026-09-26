import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import Chip, { type ChipProps } from "@mui/material/Chip";
import type { Verdict } from "@vibread/core";
import type { ReactElement } from "react";

interface VerdictStyle {
  label: string;
  color: ChipProps["color"];
  icon: ReactElement;
}

/** Every verdict has a word and a distinct icon shape; color only reinforces it. */
export const VERDICT_STYLE: Record<Verdict | "NONE", VerdictStyle> = {
  GO: { label: "GO", color: "success", icon: <CheckCircleIcon /> },
  "NO-GO": { label: "NO-GO", color: "error", icon: <CancelIcon /> },
  PENDING: { label: "Waiting", color: "warning", icon: <HourglassEmptyIcon /> },
  SKIPPED: { label: "Skipped", color: "default", icon: <RemoveCircleOutlineIcon /> },
  NONE: { label: "Not run yet", color: "default", icon: <RadioButtonUncheckedIcon /> },
};

export function VerdictChip({ verdict, size = "small" }: { verdict: Verdict | undefined; size?: ChipProps["size"] }) {
  const style = VERDICT_STYLE[verdict ?? "NONE"];
  return <Chip size={size} color={style.color} icon={style.icon} label={style.label} variant={verdict === "GO" || verdict === "NO-GO" ? "filled" : "outlined"} />;
}
