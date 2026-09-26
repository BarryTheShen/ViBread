import EditIcon from "@mui/icons-material/Edit";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { KIT_WIRE_COLORS, wireCss, type BuildState, type WireColorRequest } from "@vibread/core";
import { useState } from "react";
import { sendJson } from "../api/client.js";

/** What a picker recolours: one wire (its net shown for "whole net"), or a whole net (schematic taps). */
export type WireTarget = { jumper: string; net: string } | { net: string };

function Swatch({ color, size = 14 }: { color: string; size?: number }) {
  return <Box component="span" sx={{ display: "inline-block", width: size, height: size, borderRadius: "50%", bgcolor: wireCss(color), border: "1px solid", borderColor: "divider", flexShrink: 0 }} />;
}

/** "orange–yellow–green = LED1–LED3 (D2–D4)": one line per group of wires doing the same job. */
export function WireLegend({ wires }: { wires: BuildState["wires"] }) {
  if (!wires || wires.legend.length === 0) return null;
  return (
    <Stack direction="row" sx={{ flexWrap: "wrap", columnGap: 2, rowGap: 0.5, mt: 1 }} aria-label="Wire colour legend">
      {wires.legend.map((entry) => (
        <Stack key={`${entry.label}-${entry.colors.join()}`} direction="row" sx={{ alignItems: "center", gap: 0.5 }}>
          {entry.colors.map((color, index) => (
            <Swatch key={`${color}-${index}`} color={color} />
          ))}
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            = {entry.label}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

/** Saves a colour choice; the answer is the new BuildState, written straight into the build query. */
export function useWireColor(missionId: string, buildKey: QueryKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WireColorRequest) => sendJson<BuildState>("POST", `/api/missions/${encodeURIComponent(missionId)}/build/wire-color`, body),
    onSuccess: (state) => qc.setQueryData(buildKey, state),
  });
}

/**
 * Colour picker for one wire or net: kit swatches, a custom colour, "whole net", and "back to suggested".
 * Closes after a choice; `onPick` receives the request to send.
 */
export function WireColorPicker({
  anchor,
  target,
  wires,
  revision,
  onClose,
  onPick,
}: {
  anchor: { top: number; left: number } | null;
  target: WireTarget | null;
  wires: BuildState["wires"];
  revision: number;
  onClose: () => void;
  onPick: (request: WireColorRequest) => void;
}) {
  const [wholeNet, setWholeNet] = useState(false);
  const [custom, setCustom] = useState("#ff66aa");
  if (!target || !wires) return null;
  const jumper = "jumper" in target ? target.jumper : undefined;
  const netOnly = jumper === undefined || wholeNet;
  const current = jumper !== undefined && !wholeNet ? wires.jumpers[jumper] : wires.nets[target.net];
  const hasOverride = netOnly ? wires.overrides[`net:${target.net}`] !== undefined : wires.overrides[`wire:${jumper}`] !== undefined;
  const pick = (color: string | null) => {
    onPick({ revision, target: netOnly ? { net: target.net } : { jumper: jumper! }, color });
    setWholeNet(false);
    onClose();
  };
  return (
    <Popover open={Boolean(anchor)} anchorReference="anchorPosition" anchorPosition={anchor ?? undefined} onClose={onClose}>
      <Box sx={{ p: 1.5, maxWidth: 280 }}>
        <Typography variant="subtitle2">{netOnly ? `Colour for every ${target.net} wire` : `Colour for wire ${jumper} (${target.net})`}</Typography>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1, my: 1 }}>
          {KIT_WIRE_COLORS.map((color) => (
            <Tooltip key={color} title={color}>
              <Box
                component="button"
                type="button"
                aria-label={color}
                aria-pressed={current === color}
                onClick={() => pick(color)}
                sx={{ width: 36, height: 36, borderRadius: "50%", cursor: "pointer", bgcolor: wireCss(color), border: "3px solid", borderColor: current === color ? "primary.main" : "divider" }}
              />
            </Tooltip>
          ))}
        </Box>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <Box component="input" type="color" value={custom} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCustom(event.target.value)} aria-label="Custom colour" sx={{ width: 40, height: 32, border: 0, p: 0, bgcolor: "transparent" }} />
          <Button size="small" onClick={() => pick(custom.toLowerCase())}>
            Use custom colour
          </Button>
        </Stack>
        {jumper !== undefined && (
          <FormControlLabel control={<Checkbox size="small" checked={wholeNet} onChange={(event) => setWholeNet(event.target.checked)} />} label={`Apply to every ${target.net} wire`} />
        )}
        <Button size="small" disabled={!hasOverride} onClick={() => pick(null)}>
          Back to suggested colour
        </Button>
      </Box>
    </Popover>
  );
}

/** One chip per wire a step adds, showing its colour; tapping opens the picker. */
export function StepWireChips({ jumpers, layout, wires, onEdit }: { jumpers: string[]; layout: BuildState["layout"]; wires: BuildState["wires"]; onEdit: (target: WireTarget, anchor: { top: number; left: number }) => void }) {
  if (!wires || !layout || jumpers.length === 0) return null;
  return (
    <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1, mt: 1 }}>
      {jumpers.map((id) => {
        const jumper = layout.jumpers.find((entry) => entry.id === id);
        if (!jumper) return null;
        const color = wires.jumpers[id] ?? jumper.color;
        return (
          <Chip
            key={id}
            variant="outlined"
            icon={<Swatch color={color} size={16} />}
            deleteIcon={<EditIcon />}
            onDelete={(event: React.MouseEvent) => onEdit({ jumper: id, net: jumper.net }, { top: event.clientY, left: event.clientX })}
            onClick={(event) => onEdit({ jumper: id, net: jumper.net }, { top: event.clientY, left: event.clientX })}
            label={`${id} · ${color.startsWith("#") ? "custom" : color}`}
            aria-label={`Wire ${id} is ${color}; change colour`}
          />
        );
      })}
    </Stack>
  );
}
