import DownloadIcon from "@mui/icons-material/Download";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import type { RevisionDetail } from "@vibread/core";
import { useState } from "react";
import { SINGLE_FILES, bundlePlan, buildZip, otherFiles, saveFile, sketchName, stepPictureCount, type BundleKind } from "./downloads.js";

/** The panel's ⤓ menu for one design version: sketch and "Everything" first, then single files, then grouped zips. */
export function DownloadMenu({ revision, missionTitle }: { revision: RevisionDetail; missionTitle: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState<BundleKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = sketchName(missionTitle);
  const keys = Object.keys(revision.artifactUrls);
  const steps = stepPictureCount(keys);
  const others = otherFiles(keys).length;
  const singles = SINGLE_FILES.filter((f) => revision.artifactUrls[f.key]);

  const downloadZip = async (kind: BundleKind) => {
    setBusy(kind);
    try {
      const plan = bundlePlan(kind, name, revision.n, revision.circuit, keys);
      const bytes = await buildZip(plan.entries, async (key) => {
        const response = await fetch(revision.artifactUrls[key], { credentials: "same-origin" });
        if (!response.ok) throw new Error(`${key} couldn't be loaded (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      });
      saveFile(bytes, plan.fileName, "application/zip");
      setAnchor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const zipRow = (kind: BundleKind, primary: string, secondary: string) => (
    <MenuItem disabled={busy !== null} onClick={() => void downloadZip(kind)}>
      <ListItemText primary={busy === kind ? "Preparing the zip…" : primary} secondary={secondary} />
    </MenuItem>
  );

  return (
    <>
      <Tooltip title="Download design files">
        <IconButton aria-label="Download design files" onClick={(e) => setAnchor(e.currentTarget)}>
          <DownloadIcon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)} slotProps={{ list: { dense: true, sx: { minWidth: 300 } } }}>
        <ListSubheader>Get the code · design r{revision.n}</ListSubheader>
        <MenuItem
          onClick={() => {
            saveFile(revision.circuit.sketch.source, `${name}.ino`, "text/x-arduino;charset=utf-8");
            setAnchor(null);
          }}
        >
          <ListItemText primary="Arduino sketch (.ino)" secondary={`${name}.ino · open it in the Arduino IDE`} />
        </MenuItem>
        {zipRow("everything", "Everything (.zip)", "Sketch folder, compiled HEX, schematic, breadboard, step pictures, parts list")}
        {singles.some((f) => f.group === "Compiled") && <ListSubheader>Compiled</ListSubheader>}
        {singles
          .filter((f) => f.group === "Compiled")
          .map((f) => (
            <MenuItem key={f.key} component="a" href={revision.artifactUrls[f.key]} download={`${name}-r${revision.n}${f.suffix}`} onClick={() => setAnchor(null)}>
              {f.label}
            </MenuItem>
          ))}
        {(singles.some((f) => f.group === "Pictures") || steps > 0) && <ListSubheader>Pictures</ListSubheader>}
        {singles
          .filter((f) => f.group === "Pictures")
          .map((f) => (
            <MenuItem key={f.key} component="a" href={revision.artifactUrls[f.key]} download={`${name}-r${revision.n}${f.suffix}`} onClick={() => setAnchor(null)}>
              {f.label}
            </MenuItem>
          ))}
        {steps > 0 && zipRow("steps", `All ${steps} step pictures (.zip)`, "One picture per build step")}
        {others > 0 && <ListSubheader>For troubleshooting</ListSubheader>}
        {others > 0 && zipRow("other", `Simulation traces and reports (.zip)`, `${others} file${others === 1 ? "" : "s"}`)}
      </Menu>
      <Snackbar open={error !== null} autoHideDuration={8000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          Couldn't make the download: {error}
        </Alert>
      </Snackbar>
    </>
  );
}
