import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import CloseIcon from "@mui/icons-material/Close";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import QrCode2OutlinedIcon from "@mui/icons-material/QrCode2Outlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import { BOARD_VARIANTS, BREADBOARD_PROFILES, PART_VARIANTS, hardwareIds, type BoardVariantId, type BreadboardProfileId, type HardwareConfidence, type HardwareIdentification, type HardwareKind } from "@vibread/core";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnections } from "../api/hooks.js";
import { useCreateScan, useScan } from "../api/inventory.js";
import { BreadboardDrawing } from "./BreadboardDrawing.js";
import { useIdentifyHardware, type HardwarePhoto } from "./hardwareApi.js";
import { phoneLink, phonePairQuery } from "./ScanDialog.js";
import { cameraErrorMessage, scanErrorMessage } from "./scanErrors.js";
import { isCameraContextAvailable, isCameraSecure, useCamera } from "./useCamera.js";

const KIND_LABELS: Record<HardwareKind, string> = { breadboard: "Breadboard", board: "Board", part: "Part" };
const CONFIDENCE_LABELS: Record<HardwareConfidence, string> = { high: "Sure", medium: "Likely", low: "Unsure" };

/** Display name of a catalogue id of this kind. */
export function hardwareName(kind: HardwareKind, id: string): string {
  if (kind === "breadboard") return BREADBOARD_PROFILES[id as BreadboardProfileId]?.shortName ?? id;
  if (kind === "board") return BOARD_VARIANTS[id as BoardVariantId]?.name ?? id;
  return PART_VARIANTS.find((variant) => variant.id === id)?.name ?? id;
}

function hardwareFacts(kind: HardwareKind, id: string): string[] {
  if (kind === "breadboard") return BREADBOARD_PROFILES[id as BreadboardProfileId]?.identify ?? [];
  if (kind === "board") return BOARD_VARIANTS[id as BoardVariantId]?.identify ?? [];
  return PART_VARIANTS.find((variant) => variant.id === id)?.identify ?? [];
}

export interface IdentifyHardwareDialogProps {
  open: boolean;
  initialKind: HardwareKind;
  claude: "connected" | "missing";
  onClose(): void;
  onConfirm(kind: HardwareKind, id: string): void;
  /** Nothing in the catalogue matches: open the part-type editor with this description. */
  onCreateType(description: string): void;
}

/**
 * "Identify from a photo" (issue #23): a photo from an upload, this computer's camera, or the phone (the parts scan's
 * QR page) goes to Claude; the guess and its reasons come back for the person to confirm or replace. Without Claude
 * it says so and points at the pickers.
 */
export function IdentifyHardwareDialog({ open, initialKind, claude, onClose, onConfirm, onCreateType }: IdentifyHardwareDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [kind, setKind] = useState<HardwareKind>(initialKind);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanId, setScanId] = useState("");
  const [seenPhotos, setSeenPhotos] = useState(0);
  const [other, setOther] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const camera = useCamera();
  const identify = useIdentifyHardware();
  const createScan = useCreateScan();
  const scan = useScan(scanId, Boolean(scanId) && open);
  const connections = useConnections();
  const pairing = useMemo(() => phonePairQuery(connections.data), [connections.data]);
  const result = identify.data;

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      return;
    }
    identify.reset();
    createScan.reset();
    setScanId("");
    setSeenPhotos(0);
    setOther("");
    camera.setOpen(false);
    setPreview((current) => {
      if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
      return null;
    });
  }, [open, initialKind]);

  const run = (photo: HardwarePhoto) => {
    setOther("");
    identify.mutate({ photo, kind });
  };
  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setPreview((current) => {
      if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    run({ file });
  };

  // The phone adds photos to the scan; each new one is identified here as it arrives.
  const phonePhotos = scan.data?.photos ?? 0;
  useEffect(() => {
    if (!scanId || phonePhotos <= seenPhotos) return;
    setSeenPhotos(phonePhotos);
    setPreview(null);
    run({ scanId });
  }, [scanId, phonePhotos]);

  const answer = (identification: HardwareIdentification) => {
    const known = identification.kind !== "unknown" ? identification.kind : kind;
    const choices = identification.kind === "unknown" ? hardwareIds(kind) : [identification.profileOrVariantId, ...identification.alternatives].filter((id): id is string => Boolean(id));
    return (
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            {identification.profileOrVariantId ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <Typography variant="h3">Looks like: {hardwareName(known, identification.profileOrVariantId)}</Typography>
                <Chip size="small" label={CONFIDENCE_LABELS[identification.confidence]} color={identification.confidence === "high" ? "success" : identification.confidence === "medium" ? "info" : "warning"} />
              </Stack>
            ) : (
              <Typography variant="h3">No match in ViBread's catalogue</Typography>
            )}
            <Typography variant="body2" color="text.secondary">{identification.description}</Typography>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>Why</Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, typography: "body2" }}>
                {identification.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </Box>
            </Box>
            {known === "breadboard" && identification.profileOrVariantId ? <BreadboardDrawing profile={identification.profileOrVariantId as BreadboardProfileId} scale={1} /> : null}
            {identification.profileOrVariantId ? <Typography variant="body2" color="text.secondary">Check: {hardwareFacts(known, identification.profileOrVariantId).join(" · ")}</Typography> : null}
            {identification.kind !== "unknown" && identification.kind !== kind ? <Alert severity="warning">This photo looks like a {KIND_LABELS[identification.kind].toLowerCase()}, not a {KIND_LABELS[kind].toLowerCase()}.</Alert> : null}
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
              {identification.profileOrVariantId ? <Button variant="contained" onClick={() => onConfirm(known, identification.profileOrVariantId!)}>Yes, that's mine</Button> : null}
              <TextField select size="small" label="Choose another" value={other} onChange={(event) => setOther(event.target.value)} sx={{ minWidth: 220 }}>
                {choices.filter((id) => id !== identification.profileOrVariantId).map((id) => <MenuItem key={id} value={id}>{hardwareName(known, id)}</MenuItem>)}
              </TextField>
              <Button variant="outlined" disabled={!other} onClick={() => onConfirm(known, other)}>Use this one</Button>
            </Stack>
            {known === "part" || identification.kind === "unknown" ? (
              <Button variant="text" sx={{ alignSelf: "flex-start" }} onClick={() => onCreateType(identification.description)}>None of these — make a new part type</Button>
            ) : (
              <Typography variant="caption" color="text.secondary">Not listed? Pick the closest one; the drawing and steps use its layout.</Typography>
            )}
          </Stack>
        </CardContent>
      </Card>
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen} scroll="paper" aria-labelledby="identify-hardware-title">
      <DialogTitle id="identify-hardware-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Identify from a photo
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <ToggleButtonGroup exclusive size="small" value={kind} onChange={(_, value: HardwareKind | null) => { if (value) { setKind(value); identify.reset(); } }} aria-label="What the photo shows">
            {(Object.keys(KIND_LABELS) as HardwareKind[]).map((value) => <ToggleButton key={value} value={value}>{KIND_LABELS[value]}</ToggleButton>)}
          </ToggleButtonGroup>
          {claude === "missing" ? (
            <Alert severity="warning">Claude isn't connected, so ViBread can't read photos. Pick yours from the lists on the Inventory page instead (or connect Claude in Settings).</Alert>
          ) : (
            <>
              <Typography color="text.secondary">
                {kind === "breadboard" ? "Photograph the whole board from above so the row numbers and rail lines show." : kind === "board" ? "Photograph the board from above, with the chip next to the USB socket in view." : "Photograph one part on plain paper, close up, with its legs visible."}
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <Button variant="contained" startIcon={<CloudUploadOutlinedIcon />} onClick={() => inputRef.current?.click()} disabled={identify.isPending}>Upload or take a photo</Button>
                <input ref={inputRef} hidden type="file" accept="image/*" onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
                {isCameraContextAvailable() ? (
                  <Button variant="outlined" startIcon={<CameraAltOutlinedIcon />} disabled={Boolean(camera.error)} onClick={() => camera.setOpen(!camera.open)}>{camera.open && camera.ready ? "Hide camera" : fullScreen ? "Use the live camera" : "Use this computer's camera"}</Button>
                ) : null}
                {fullScreen ? null : <Button variant="outlined" startIcon={<QrCode2OutlinedIcon />} disabled={Boolean(scanId) || createScan.isPending} onClick={() => createScan.mutate(undefined, { onSuccess: (created) => { setSeenPhotos(created.photos ?? 0); setScanId(created.id); } })}>Use your phone</Button>}
              </Stack>
              {!isCameraContextAvailable() ? <Typography variant="caption" color="text.secondary">{cameraErrorMessage({ name: "NotFoundError" }, isCameraSecure())}</Typography> : null}
              {camera.error ? <Alert severity="warning">{camera.error}</Alert> : null}
              {camera.open && camera.ready ? (
                <Stack spacing={1}>
                  <Box component="video" ref={camera.videoRef} autoPlay muted playsInline sx={{ width: "100%", maxHeight: 320, objectFit: "cover", bgcolor: "background.paper", borderRadius: 1 }} />
                  <Button variant="contained" disabled={identify.isPending} onClick={() => void camera.capture().then((file) => { if (file) { camera.setOpen(false); chooseFile(file); } })}>Take photo</Button>
                </Stack>
              ) : null}
              {createScan.error ? <Alert severity="error">{createScan.error instanceof Error ? createScan.error.message : "Could not start the phone link."}</Alert> : null}
              {scanId ? (
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
                  <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "qr.main" }}><QRCodeSVG value={phoneLink(connections.data?.phoneUrl, scanId, pairing, { hardware: kind })} size={140} includeMargin /></Box>
                  <Typography color="text.secondary">Scan this with your phone and take the photo there. It shows up here as soon as it uploads{phonePhotos > 0 ? ` (${phonePhotos} received)` : ""}.</Typography>
                </Stack>
              ) : null}
            </>
          )}
          {preview ? <Box component="img" src={preview} alt="Your photo" sx={{ maxWidth: "100%", maxHeight: 260, objectFit: "contain", alignSelf: "flex-start", borderRadius: 1 }} /> : null}
          {identify.isPending ? <Stack spacing={1}><Typography>Claude is looking at your photo…</Typography><LinearProgress aria-label="Identifying" /></Stack> : null}
          {identify.error ? <Alert severity="error">{scanErrorMessage(identify.error)} You can also pick yours from the lists on the Inventory page.</Alert> : null}
          {result ? answer(result) : null}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
