import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import {
  BOARD_VARIANTS,
  BREADBOARD_PROFILES,
  MODULES,
  PART_VARIANTS,
  type BoardVariantId,
  type BreadboardProfileId,
  type HardwareKind,
  type HardwareSource,
  type ModuleKey,
  type MyHardware,
} from "@vibread/core";
import { useState } from "react";
import { BreadboardDrawing } from "./BreadboardDrawing.js";
import { useHardware, useSaveHardware } from "./hardwareApi.js";
import { IdentifyHardwareDialog } from "./IdentifyHardwareDialog.js";

/** Modules with a real choice of physical variant (buzzers are already two part types). */
const VARIANT_MODULES = [...new Set(PART_VARIANTS.map((variant) => variant.module))].filter((module) => PART_VARIANTS.filter((variant) => variant.module === module).length > 1);

const SOURCE_TEXT: Record<HardwareSource, string> = { saved: "Your pick", inventory: "From your inventory", default: "Not picked yet" };

function Choice({ selected, title, onClick, children }: { selected: boolean; title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Card variant="outlined" sx={{ borderColor: selected ? "primary.main" : "divider", borderWidth: selected ? 2 : 1, height: "100%" }}>
      <CardActionArea onClick={onClick} aria-pressed={selected} aria-label={title} sx={{ height: "100%", p: 1.25, display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
          <Typography sx={{ fontWeight: 700, flex: 1 }}>{title}</Typography>
          {selected ? <CheckCircleIcon color="primary" fontSize="small" aria-hidden /> : null}
        </Stack>
        {children}
      </CardActionArea>
    </Card>
  );
}

/**
 * "Your hardware" (issue #23): the breadboard, board and part variants new missions build for. Every pick saves at
 * once; "Identify from a photo" suggests one to confirm. Without Claude the pickers are the whole flow.
 */
export function HardwareSection({ onCreateType }: { onCreateType(description: string): void }) {
  const view = useHardware();
  const save = useSaveHardware();
  const [identify, setIdentify] = useState<HardwareKind | null>(null);

  if (view.isLoading) return <Card><CardContent><CircularProgress size={22} aria-label="Loading your hardware" /></CardContent></Card>;
  if (view.error || !view.data) return <Alert severity="error">{view.error instanceof Error ? view.error.message : "Could not load your hardware."}</Alert>;
  const { hardware, source, claude } = view.data;
  const update = (patch: Partial<MyHardware>) => save.mutate({ ...hardware, ...patch });
  const setPart = (module: ModuleKey, variant: string | null) => {
    const parts = { ...hardware.parts };
    if (variant) parts[module] = variant;
    else delete parts[module];
    update({ parts });
  };
  const grid = { display: "grid", gap: 1.25, gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(4, 1fr)" } } as const;
  // Breadboard cards are mostly drawing: two per row even on a phone.
  const boardGrid = { ...grid, gridTemplateColumns: { xs: "repeat(2, 1fr)", md: "repeat(4, 1fr)" } } as const;

  return (
    <Card component="section" aria-labelledby="your-hardware-title">
      <CardContent>
        <Stack spacing={2.5}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
            <Box>
              <Typography id="your-hardware-title" variant="h2">Your hardware</Typography>
              <Typography color="text.secondary">New missions build for these, and the steps name them ("your 400-point board", "5 mm red LED").</Typography>
            </Box>
            <Button variant="outlined" startIcon={<CameraAltOutlinedIcon />} onClick={() => setIdentify("breadboard")} sx={{ flexShrink: 0 }}>Identify from a photo</Button>
          </Stack>
          {save.error ? <Alert severity="error">{save.error instanceof Error ? save.error.message : "Could not save your hardware."}</Alert> : null}

          <Box component="section" aria-labelledby="hw-breadboard">
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
              <Typography id="hw-breadboard" variant="h3" sx={{ flex: 1 }}>Breadboard</Typography>
              <Chip size="small" variant="outlined" label={SOURCE_TEXT[source.breadboard]} />
            </Stack>
            <Box sx={boardGrid}>
              {(Object.keys(BREADBOARD_PROFILES) as BreadboardProfileId[]).map((id) => {
                const profile = BREADBOARD_PROFILES[id];
                return (
                  <Choice key={id} selected={hardware.breadboard === id} title={profile.shortName} onClick={() => update({ breadboard: id })}>
                    <BreadboardDrawing profile={id} />
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{profile.identify.slice(0, 2).join(" · ")}</Typography>
                  </Choice>
                );
              })}
            </Box>
          </Box>

          <Box component="section" aria-labelledby="hw-board">
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
              <Typography id="hw-board" variant="h3" sx={{ flex: 1 }}>Board</Typography>
              <Chip size="small" variant="outlined" label={SOURCE_TEXT[source.board]} />
            </Stack>
            <Box sx={grid}>
              {(Object.keys(BOARD_VARIANTS) as BoardVariantId[]).map((id) => {
                const variant = BOARD_VARIANTS[id];
                return (
                  <Choice key={id} selected={hardware.board === id} title={variant.shortName} onClick={() => update({ board: id })}>
                    <Typography variant="body2">USB chip: {variant.usbChip}</Typography>
                    <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.25, color: "text.secondary", typography: "body2" }}>
                      {variant.identify.map((line) => <li key={line}>{line}</li>)}
                    </Box>
                  </Choice>
                );
              })}
            </Box>
          </Box>

          <Box component="section" aria-labelledby="hw-parts">
            <Typography id="hw-parts" variant="h3" sx={{ mb: 1 }}>Part variants</Typography>
            <Stack spacing={1.75}>
              {VARIANT_MODULES.map((module) => {
                const variants = PART_VARIANTS.filter((variant) => variant.module === module);
                const chosen = variants.find((variant) => variant.variant === hardware.parts[module]);
                return (
                  <Box key={module}>
                    <Typography sx={{ fontWeight: 600, mb: 0.5 }}>{MODULES[module].name}</Typography>
                    <ToggleButtonGroup
                      exclusive
                      size="small"
                      value={hardware.parts[module] ?? ""}
                      onChange={(_, value: string | null) => { if (value !== null) setPart(module, value || null); }}
                      aria-label={`${MODULES[module].name} variant`}
                      sx={{ flexWrap: "wrap" }}
                    >
                      <ToggleButton value="">Not set</ToggleButton>
                      {variants.map((variant) => <ToggleButton key={variant.id} value={variant.variant}>{variant.name}</ToggleButton>)}
                    </ToggleButtonGroup>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {chosen ? `${chosen.identify.join(" · ")}. ${chosen.orientation}` : "Not set: the steps use the usual shape and don't name a size."}
                    </Typography>
                  </Box>
                );
              })}
              <Button variant="text" size="small" startIcon={<CameraAltOutlinedIcon />} onClick={() => setIdentify("part")} sx={{ alignSelf: "flex-start" }}>Identify a part from a photo</Button>
            </Stack>
          </Box>
        </Stack>
      </CardContent>
      <IdentifyHardwareDialog
        open={identify !== null}
        initialKind={identify ?? "breadboard"}
        claude={claude}
        onClose={() => setIdentify(null)}
        onConfirm={(kind, id) => {
          if (kind === "breadboard") update({ breadboard: id as BreadboardProfileId });
          else if (kind === "board") update({ board: id as BoardVariantId });
          else {
            const variant = PART_VARIANTS.find((candidate) => candidate.id === id);
            if (variant) update({ parts: { ...hardware.parts, [variant.module]: variant.variant } });
          }
          setIdentify(null);
        }}
        onCreateType={(description) => { setIdentify(null); onCreateType(description); }}
      />
    </Card>
  );
}
