import KeyboardDoubleArrowDownIcon from "@mui/icons-material/KeyboardDoubleArrowDown";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { MONO_FONT } from "../theme.js";

const SCROLL_BOTTOM_TOLERANCE = 32;
export const SERIAL_LIMIT = 4000;

export function isSerialMonitorAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, tolerance = SCROLL_BOTTOM_TOLERANCE): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerance;
}

interface SerialMonitorProps {
  value: string;
  title?: string;
  ariaLabel?: string;
  emptyText?: string;
  height?: number | string;
  maxHeight?: number | string;
}

/** Shared output monitor for simulator serial text and bench telemetry lines. */
export function SerialMonitor({
  value,
  title = "Serial monitor (what the Arduino prints)",
  ariaLabel = "Serial output",
  emptyText = "Nothing printed yet.",
  height = 120,
  maxHeight,
}: SerialMonitorProps) {
  const logRef = useRef<HTMLPreElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const displayValue = value.length > SERIAL_LIMIT ? value.slice(-SERIAL_LIMIT) : value;

  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [autoScroll, displayValue]);

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          {title}
        </Typography>
        <Button
          size="small"
          variant={autoScroll ? "contained" : "outlined"}
          startIcon={<KeyboardDoubleArrowDownIcon fontSize="small" />}
          aria-label={autoScroll ? "Turn off auto-scroll" : "Turn on auto-scroll"}
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll((current) => !current)}
          sx={{ minHeight: 32, whiteSpace: "nowrap" }}
        >
          {autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
        </Button>
      </Stack>
      <Box
        component="pre"
        ref={logRef}
        role="region"
        aria-label={ariaLabel}
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = isSerialMonitorAtBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
          setAutoScroll((current) => (current === atBottom ? current : atBottom));
        }}
        sx={{
          m: 0,
          mt: 0.5,
          p: 1,
          bgcolor: "code.main",
          borderRadius: 1,
          fontFamily: MONO_FONT,
          fontSize: 12.5,
          height,
          maxHeight,
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {displayValue || emptyText}
      </Box>
    </Box>
  );
}
