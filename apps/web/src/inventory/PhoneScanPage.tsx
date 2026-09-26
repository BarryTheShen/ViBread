import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ScanItem } from "@vibread/core";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAcceptScan, useAnalyzeScan, useCatalog, useScan, useUploadScanPhoto } from "../api/inventory.js";
import { scanErrorMessage, scanViewErrorMessage } from "./scanErrors.js";
import { ScanReview } from "./ScanReview.js";
interface PhonePhoto {
  id: string;
  file: File;
  url: string;
  status: "uploading" | "uploaded" | "failed";
}

export function PhoneScanPage() {
  const { scanId = "" } = useParams<{ scanId: string }>();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const scan = useScan(scanId);
  const upload = useUploadScanPhoto(scanId);
  const analyze = useAnalyzeScan(scanId);
  const accept = useAcceptScan(scanId);
  const [photos, setPhotos] = useState<PhonePhoto[]>([]);
  const photosRef = useRef<PhonePhoto[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analysisFailure, setAnalysisFailure] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url)), []);

  const addPhotos = async (files: File[]) => {
    setUploadError(null);
    for (const file of files) {
      const id = `${file.name}-${file.lastModified}-${Math.random()}`;
      const photo: PhonePhoto = { id, file, url: URL.createObjectURL(file), status: "uploading" };
      setPhotos((current) => [...current, photo]);
      try {
        await upload.mutateAsync(file);
        setPhotos((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "uploaded" } : candidate));
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Photo upload failed. Try again.");
        setPhotos((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "failed" } : candidate));
      }
    }
  };

  const analyzeNow = () => {
    setAnalysisFailure(false);
    analyze.reset();
    analyze.mutate(undefined, { onSuccess: () => setAnalysisFailure(false), onError: () => setAnalysisFailure(true) });
  };
  const onCreateType = (_item: ScanItem) => navigate("/inventory");

  if (!scanId) {
    return <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2 }}><Alert severity="error">This scan link is missing its scan id.</Alert></Box>;
  }

  const current = scan.data;
  return (
    <PhoneFrame>
      <Stack spacing={2.5}>
        <Stack spacing={0.5}>
          <Typography variant="h1" sx={{ fontSize: "1.8rem" }}>Scan parts</Typography>
          <Typography color="text.secondary">Take clear photos of each pile. Your laptop will see them as they upload.</Typography>
        </Stack>
        <Button component="label" variant="contained" size="large" startIcon={<CameraAltOutlinedIcon />} sx={{ minHeight: 58, fontSize: "1.05rem" }}>
          Take photo
          <input hidden type="file" accept="image/*" capture="environment" multiple onChange={(event) => void addPhotos(Array.from(event.target.files ?? []))} />
        </Button>
        {photos.length > 0 ? (
          <Stack spacing={1}>
            <Typography variant="h3">Photos ({photos.length})</Typography>
            <Stack direction="row" spacing={1} sx={{ overflowX: "auto", pb: 0.5 }}>
              {photos.map((photo) => (
                <Box key={photo.id} sx={{ position: "relative", flex: "0 0 92px" }}>
                  <Box component="img" src={photo.url} alt={photo.file.name || "Uploaded scan"} sx={{ width: 92, height: 92, objectFit: "cover", borderRadius: 1, display: "block", opacity: photo.status === "uploading" ? 0.55 : 1 }} />
                  {photo.status === "uploading" ? <LinearProgress sx={{ position: "absolute", bottom: 0, left: 0, right: 0 }} /> : null}
                  {photo.status === "uploaded" ? <CheckCircleOutlineOutlinedIcon color="success" sx={{ position: "absolute", right: 2, bottom: 2, bgcolor: "background.paper", borderRadius: "50%" }} /> : null}
                  {photo.status === "failed" ? <Typography variant="caption" color="error" sx={{ display: "block" }}>Upload failed</Typography> : null}
                </Box>
              ))}
            </Stack>
</Stack>
        ) : null}
        {scan.isLoading ? <LinearProgress aria-label="Loading scan status" /> : null}
        {scan.error ? <Alert severity="error">{scan.error instanceof Error ? scan.error.message : "Could not load this scan yet."}</Alert> : null}
        {uploadError ? <Alert severity="error">{uploadError}</Alert> : null}
        {!analysisFailure && current?.status === "waiting" ? <Alert severity="info">{current.photos > 0 ? `${current.photos} photo${current.photos === 1 ? "" : "s"} ready — when you're ready, read the list.` : "Take at least one photo to continue."}</Alert> : null}
        {!analysisFailure && current?.status === "analyzing" ? <Alert severity="info">Reading your parts… keep this page open.</Alert> : null}
        {analysisFailure || current?.status === "failed" ? (
          <Alert severity="error" action={<Button onClick={analyzeNow} disabled={analyze.isPending}>Retry</Button>}>
            {analysisFailure ? scanErrorMessage(analyze.error) : current ? scanViewErrorMessage(current) : "The scan could not be read."}
          </Alert>
        ) : null}
        {current?.claude === "missing" ? <Alert severity="warning">Claude is not connected for this scan. <Button onClick={() => navigate("/inventory")}>Type parts instead</Button></Alert> : null}
        {!analysisFailure && current?.status === "waiting" ? <Button variant="contained" onClick={analyzeNow} disabled={current.photos === 0 || photos.some((photo) => photo.status === "uploading") || analyze.isPending || current.claude === "missing"}>{analyze.isPending ? "Reading…" : "Done — read my parts"}</Button> : null}
        {current?.status === "ready" ? (
          <>
            <Alert severity="success">Check the list on your laptop (or here).</Alert>
            <ScanReview
              scan={current}
              catalog={catalog.data}
              phone
              onAccept={(request) => accept.mutate(request, { onSuccess: () => setSaved(true) })}
              onCreateType={onCreateType}
            />
            {accept.error ? <Alert severity="error">{accept.error instanceof Error ? accept.error.message : "Could not save this scan."}</Alert> : null}
            {saved ? <Alert severity="success">Your parts are in inventory.</Alert> : null}
          </>
        ) : null}
      </Stack>
    </PhoneFrame>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return <Box sx={{ minHeight: "100vh", bgcolor: "background.default", px: 1.5, py: 2 }}><Box sx={{ maxWidth: 390, mx: "auto", width: "100%" }}>{children}</Box></Box>;
}

export default PhoneScanPage;
