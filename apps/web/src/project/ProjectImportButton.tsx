import UploadFileIcon from "@mui/icons-material/UploadFile";
import Alert from "@mui/material/Alert";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { queryKeys } from "../api/hooks.js";
import { importProject } from "./projectFile.js";

function isProjectFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".vibread");
}

export function ProjectImportButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = async (file: File) => {
    if (!isProjectFile(file)) {
      setError("Choose a .vibread project file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await importProject(file);
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions });
      navigate(`/m/${encodeURIComponent(result.missionId)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      const file = [...(event.dataTransfer?.files ?? [])].find(isProjectFile);
      if (!file) {
        if (event.dataTransfer?.types.includes("Files")) setError("Choose a .vibread project file.");
        return;
      }
      void importFile(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  });

  const picker = (
    <input
      ref={inputRef}
      hidden
      type="file"
      accept=".vibread"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFile(file);
      }}
    />
  );

  const item = (
    <ListItemButton
      onClick={() => inputRef.current?.click()}
      disabled={busy}
      aria-label={collapsed ? "Import project" : undefined}
      sx={{
        minHeight: 44,
        px: collapsed ? 1.5 : 1.75,
        borderRadius: 2,
        justifyContent: collapsed ? "center" : "flex-start",
        color: "text.secondary",
      }}
    >
      <ListItemIcon sx={{ minWidth: collapsed ? 0 : 38, color: "inherit", justifyContent: "center" }}>
        <UploadFileIcon />
      </ListItemIcon>
      {!collapsed && <ListItemText primary={busy ? "Importing and checking…" : "Import project"} />}
    </ListItemButton>
  );

  return (
    <>
      {collapsed ? <Tooltip title={busy ? "Importing and checking the design…" : "Import project"} placement="right">{item}</Tooltip> : item}
      {picker}
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mt: 0.5, fontSize: "0.8rem" }}>
          {error}
        </Alert>
      )}
    </>
  );
}
