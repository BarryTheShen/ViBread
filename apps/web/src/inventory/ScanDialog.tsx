import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import CloseIcon from "@mui/icons-material/Close";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import QrCode2OutlinedIcon from "@mui/icons-material/QrCode2Outlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { QRCodeSVG } from "qrcode.react";
import type { CatalogView, ScanItem } from "@vibread/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnections } from "../api/hooks.js";
import { useAcceptScan, useAnalyzeScan, useCreateScan, useScan, useUploadScanPhoto } from "../api/inventory.js";
import { ScanReview } from "./ScanReview.js";

export interface ScanDialogProps {
  open: boolean;
  catalog: CatalogView | undefined;
  onClose(): void;
  onTypeParts(): void;
  onCreateType(item: ScanItem): void;
}

function isCameraContextAvailable(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  if (window.isSecureContext) return true;
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

function phoneLink(phoneUrl: string | undefined, scanId: string, pairing: string | undefined): string {
  let origin = window.location.origin;
  if (phoneUrl) {
    try {
      origin = new URL(phoneUrl).origin;
    } catch {
      // Keep the current origin when an older server sends an invalid phone URL.
    }
  }
  const query = pairing?.replace(/^\?/, "");
  return `${origin}/scan/${encodeURIComponent(scanId)}${query ? `?${query}` : ""}`;
}

function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
}

export function ScanDialog({ open, catalog, onClose, onTypeParts, onCreateType }: ScanDialogProps) {
  const connections = useConnections();
  const create = useCreateScan();
  const [scanId, setScanId] = useState("");
  const scan = useScan(scanId, Boolean(scanId));
  const upload = useUploadScanPhoto(scanId);
  const analyze = useAnalyzeScan(scanId);
  const accept = useAcceptScan(scanId);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      create.reset();
      setScanId("");
      setUploadedFiles([]);
      setCameraOpen(false);
      setCameraError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!cameraOpen) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraReady(false);
      return;
    }
    let disposed = false;
    setCameraError(null);
    setCameraReady(false);
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then((stream) => {
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraReady(true);
    }).catch(() => setCameraError("Camera access was blocked. You can upload a photo instead."));
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraReady(false);
    };
  }, [cameraOpen]);

  const pairing = useMemo(() => {
    const data: unknown = connections.data;
    if (typeof data !== "object" || data === null || !("phonePairQuery" in data)) return undefined;
    return typeof data.phonePairQuery === "string" ? data.phonePairQuery : undefined;
  }, [connections.data]);
  const scanLink = scanId ? phoneLink(connections.data?.phoneUrl, scanId, pairing) : "";
  const cameraAvailable = isCameraContextAvailable();
  const claudeUnavailable = Boolean(connections.data?.claude && connections.data.claude.using === "none" && !connections.data.claude.connected);

  const ensureScan = () => {
    if (scanId) return;
    create.mutate(undefined, { onSuccess: (result) => setScanId(result.id) });
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    ensureScan();
    // A newly-created scan resolves asynchronously; the file picker is disabled until the QR/upload controls render.
    if (!scanId) return;
    setUploading(true);
    try {
      for (const file of files) {
        await upload.mutateAsync(file);
        setUploadedFiles((current) => [...current, file.name || "photo"]);
      }
    } finally {
      setUploading(false);
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || !scanId) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await blobFromCanvas(canvas);
    if (!blob) return;
    await uploadFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]);
  };

  const reset = () => {
    setScanId("");
    setUploadedFiles([]);
    setCameraOpen(false);
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="scan-dialog-title">
      <DialogTitle id="scan-dialog-title" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Scan parts
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {!scanId ? (
          <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
            <Typography>Take photos on this computer or scan the QR code with your phone. The review list stays shared between both.</Typography>
            {claudeUnavailable ? <Alert severity="warning" sx={{ width: "100%" }}>Claude is not connected, so camera scans are unavailable. Type parts instead.</Alert> : null}
            <Button variant="contained" startIcon={create.isPending ? <CircularProgress size={18} /> : <QrCode2OutlinedIcon />} onClick={ensureScan} disabled={create.isPending || claudeUnavailable}>{create.isPending ? "Starting scan…" : "Start a scan"}</Button>
            {create.error ? <Alert severity="error">{create.error instanceof Error ? create.error.message : "Could not start a scan."}</Alert> : null}
            <Alert severity="info" sx={{ width: "100%" }}>
              Capture on white paper, one kind per group, no more than 10 in a pile, spaced apart, in good light. Photograph each pile once.
            </Alert>
            <Button variant="text" onClick={onTypeParts}>No camera or Claude? Type parts instead</Button>
          </Stack>
        ) : (
          <Stack spacing={2.5}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
              <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }}><QRCodeSVG value={scanLink} size={156} includeMargin /></Box>
              <Stack spacing={1} sx={{ flex: 1 }}>
                <Typography variant="h3">Add photos from your phone</Typography>
                <Typography color="text.secondary">Open this QR on a paired phone, or upload photos below. The phone page is <code>/scan/{scanId}</code>.</Typography>
                <Typography variant="body2" color="text.secondary">{scanLink}</Typography>
              </Stack>
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <Button variant="outlined" startIcon={<CloudUploadOutlinedIcon />} onClick={() => inputRef.current?.click()} disabled={uploading}>Upload photos</Button>
              <input ref={inputRef} hidden type="file" accept="image/*" multiple onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} />
              {cameraAvailable ? <Button variant="outlined" startIcon={<CameraAltOutlinedIcon />} onClick={() => setCameraOpen((value) => !value)}>{cameraOpen ? "Hide camera" : "Use this computer's camera"}</Button> : null}
            </Stack>
            {cameraOpen && cameraReady ? (
              <Stack spacing={1}>
                <Box component="video" ref={videoRef} autoPlay muted playsInline sx={{ width: "100%", maxHeight: 360, objectFit: "cover", bgcolor: "background.paper", borderRadius: 1 }} />
                <Button variant="contained" onClick={() => void capturePhoto()} disabled={!streamRef.current || uploading}>Capture photo</Button>
                {cameraError ? <Alert severity="warning">{cameraError}</Alert> : null}
              </Stack>
            ) : cameraOpen && cameraError ? <Alert severity="warning">{cameraError}</Alert> : null}
            {uploading ? <LinearProgress aria-label="Uploading photos" /> : null}
            {uploadedFiles.length > 0 ? <Typography variant="body2" color="text.secondary">Uploaded: {uploadedFiles.join(", ")}</Typography> : null}
            {scan.error ? <Alert severity="error" action={<Button onClick={() => void scan.refetch()}>Retry</Button>}>{scan.error instanceof Error ? scan.error.message : "Could not refresh this scan."}</Alert> : null}
            {scan.data?.status === "waiting" ? <Alert severity="info">{scan.data.photos > 0 ? `${scan.data.photos} photo${scan.data.photos === 1 ? "" : "s"} ready` : "Waiting for photos…"}</Alert> : null}
            {scan.data?.status === "analyzing" ? <Alert severity="info">Reading your parts…</Alert> : null}
            {scan.data?.status === "failed" ? <Alert severity="error">{scan.data.error || "The scan failed."}</Alert> : null}
            {scan.data?.claude === "missing" ? <Alert severity="warning">Claude is not connected, so camera scans cannot be read yet. <Button onClick={onTypeParts}>Type parts instead</Button></Alert> : null}
            {scan.data?.status === "waiting" ? (
              <Button variant="contained" onClick={() => analyze.mutate()} disabled={(scan.data.photos ?? 0) === 0 || analyze.isPending || scan.data.claude === "missing"}>{analyze.isPending ? "Reading…" : "Read my parts"}</Button>
            ) : null}
            {analyze.error ? <Alert severity="error">{analyze.error instanceof Error ? analyze.error.message : "Could not read this scan."}</Alert> : null}
            {scan.data?.status === "ready" ? <ScanReview scan={scan.data} catalog={catalog} onAccept={(request) => accept.mutate(request, { onSuccess: onClose })} onCreateType={onCreateType} /> : null}
            {accept.error ? <Alert severity="error">{accept.error instanceof Error ? accept.error.message : "Could not save this scan."}</Alert> : null}
            <Button color="inherit" onClick={reset}>Start another scan</Button>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ScanDialog;
