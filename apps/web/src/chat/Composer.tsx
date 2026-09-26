import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CheckIcon from "@mui/icons-material/Check";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import StopIcon from "@mui/icons-material/Stop";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "@vibread/core";
import { useId, useState, type ReactNode, type Ref } from "react";
import type { ComposerProps } from "../contracts.js";
import { ComposerPartsChip } from "../inventory/PartsChip.js";

/** One-line explanations of the permission modes (PLAN §5.10), in beginner language. */
export const MODE_HELP: Record<PermissionMode, string> = {
  plan: "Talks it through and proposes. Changes nothing until you switch modes.",
  ask: "Asks you before every change to the design or code.",
  review: "Changes the design freely; asks you once before a design becomes the build target.",
  autopilot: "Picks the build target on its own when every check says GO.",
};

export const PHYSICAL_NOTE = "In every mode, board actions always wait for you at the bench.";

/** Permission-mode picker inside the chat box: a compact "Review ▾" button with a menu of the four modes. */
export function ModePicker({ value, onChange, disabled }: { value: PermissionMode; onChange(mode: PermissionMode): void; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  return (
    <>
      <Tooltip title={`${MODE_HELP[value]} ${PHYSICAL_NOTE}`}>
        <Button
          size="small"
          color="inherit"
          disabled={disabled}
          aria-label={`Permission mode: ${MODE_LABELS[value]}. Change mode`}
          aria-haspopup="menu"
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? true : undefined}
          endIcon={<ExpandMoreIcon />}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ color: "text.secondary", fontWeight: 500 }}
        >
          {MODE_LABELS[value]}
        </Button>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 400 } } }}
      >
        {PERMISSION_MODES.map((mode) => (
          <MenuItem
            key={mode}
            selected={mode === value}
            onClick={() => {
              setAnchor(null);
              if (mode !== value) onChange(mode);
            }}
            sx={{ whiteSpace: "normal", alignItems: "flex-start", py: 1 }}
          >
            <ListItemIcon sx={{ mt: 0.25 }}>{mode === value ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
            <ListItemText
              primary={`${MODE_LABELS[mode]}${mode === "review" ? " (default)" : ""}`}
              secondary={MODE_HELP[mode]}
              slotProps={{ secondary: { sx: { color: "text.secondary" } } }}
            />
          </MenuItem>
        ))}
        <Typography variant="caption" component="p" sx={{ px: 2, pt: 1, pb: 0.5, color: "text.secondary", maxWidth: 400 }}>
          {PHYSICAL_NOTE}
        </Typography>
      </Menu>
    </>
  );
}

/** Local additions to the shared ComposerProps (contracts.ts): a controlled value, a custom parts chip, sizing. */
export interface ChatComposerProps extends ComposerProps {
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

/**
 * The chat box (plan §3.1/§3.2): multi-line text (Enter sends, Shift+Enter adds a line), the Parts chip, the permission
 * mode picker and the send / stop button.
 */
export function Composer(props: ChatComposerProps) {
  const { placeholder, mode, onModeChange, parts, running, disabled = false, disabledReason, onSend, onStop } = props;
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
      <Paper
        variant="outlined"
        sx={{
          borderRadius: "18px",
          px: 2,
          pt: 1.5,
          pb: 1,
          bgcolor: "background.paper",
          borderColor: "divider",
          "&:focus-within": { borderColor: "text.secondary" },
        }}
      >
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
              maxLength: 4000,
            },
          }}
          sx={{ fontSize: "1rem", lineHeight: 1.5, "& textarea": { resize: "none" } }}
        />
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 1, flexWrap: "wrap" }}>
          {partsChip ?? <ComposerPartsChip parts={parts} />}
          <Box sx={{ flex: 1 }} />
          <ModePicker value={mode} onChange={onModeChange} />
          {running ? (
            <Tooltip title="Stop Claude">
              <IconButton
                aria-label="Stop Claude"
                onClick={onStop}
                sx={{ bgcolor: "text.primary", color: "background.paper", "&:hover": { bgcolor: "text.secondary" } }}
              >
                <StopIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title={disabled ? (disabledReason ?? "Can't send right now") : "Send (Enter) · new line: Shift+Enter"}>
              <span>
                <IconButton
                  aria-label="Send"
                  disabled={!canSend}
                  onClick={send}
                  sx={{
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    "&:hover": { bgcolor: "primary.dark" },
                    "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" },
                  }}
                >
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
