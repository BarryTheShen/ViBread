import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import StopIcon from "@mui/icons-material/Stop";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useId, useState, type ReactNode, type Ref } from "react";
import type { ComposerProps } from "../contracts.js";
import { ComposerPartsChip } from "../inventory/PartsChip.js";

/**
 * The shared ComposerProps (contracts.ts) without the permission mode (removed from the product), plus a controlled value,
 * a custom parts chip and sizing.
 */
export interface ChatComposerProps extends Omit<ComposerProps, "mode" | "onModeChange"> {
  /** Controlled text (suggestion chips and "ask the agent" buttons prefill it); uncontrolled when omitted. */
  value?: string;
  onValueChange?(value: string): void;
  /** Replaces the `parts` chip (e.g. InventoryUI's self-counting PartsChip). */
  partsChip?: ReactNode;
  minRows?: number;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Accessible name of the text box. */
  label?: string;
}

/** The chat box frame and its buttons, shared by this composer and the mission thread's (chat/MissionChat.tsx). */
export const COMPOSER_FRAME_SX = {
  borderRadius: "18px",
  px: 2,
  pt: 1.5,
  pb: 1,
  bgcolor: "background.paper",
  borderColor: "divider",
  "&:focus-within": { borderColor: "text.secondary" },
} as const;
export const SEND_BUTTON_SX = {
  bgcolor: "primary.main",
  color: "primary.contrastText",
  "&:hover": { bgcolor: "primary.dark" },
  "&.Mui-disabled, &:disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" },
} as const;
export const STOP_BUTTON_SX = { bgcolor: "text.primary", color: "background.paper", "&:hover": { bgcolor: "text.secondary" } } as const;

/**
 * The chat box (plan §3.1/§3.2): multi-line text (Enter sends, Shift+Enter adds a line), the Parts chip and the send / stop
 * button.
 */
export function Composer(props: ChatComposerProps) {
  const { placeholder, parts, running, disabled = false, disabledReason, onSend, onStop } = props;
  const { value: controlled, onValueChange, partsChip, minRows = 1, autoFocus, inputRef, label = "Message Claude" } = props;
  const [local, setLocal] = useState("");
  const text = controlled ?? local;
  const helperId = useId();
  const setText = (next: string) => {
    if (controlled === undefined) setLocal(next);
    onValueChange?.(next);
  };
  const canSend = !disabled && !running && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <Box>
      <Paper variant="outlined" sx={COMPOSER_FRAME_SX}>
        <InputBase
          multiline
          fullWidth
          minRows={minRows}
          maxRows={12}
          value={text}
          autoFocus={autoFocus}
          inputRef={inputRef}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send();
          }}
          slotProps={{
            input: {
              "aria-label": label,
              "aria-describedby": disabledReason ? helperId : undefined,
            },
          }}
          sx={{ fontSize: "1rem", lineHeight: 1.5, "& textarea": { resize: "none" } }}
        />
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 1, flexWrap: "wrap" }}>
          {partsChip ?? <ComposerPartsChip parts={parts} />}
          <Box sx={{ flex: 1 }} />
          {running ? (
            <Tooltip title="Stop Claude">
              <IconButton aria-label="Stop Claude" onClick={onStop} sx={STOP_BUTTON_SX}>
                <StopIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title={disabled ? (disabledReason ?? "Can't send right now") : "Send (Enter) · new line: Shift+Enter"}>
              <span>
                <IconButton aria-label="Send" disabled={!canSend} onClick={send} sx={SEND_BUTTON_SX}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Paper>
      {disabledReason && disabled && (
        <Typography id={helperId} variant="caption" component="p" sx={{ mt: 0.75, px: 1, color: "text.secondary" }}>
          {disabledReason}
        </Typography>
      )}
    </Box>
  );
}
