import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { MissionSummary } from "@vibread/core";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { sendJson } from "../api/client.js";
import { queryKeys } from "../api/hooks.js";
import { downloadProject } from "../project/projectFile.js";

export const MAX_MISSION_TITLE_LENGTH = 80;

/** Returns a user-facing validation message, or undefined when a title can be saved. */
export function validateMissionTitle(value: string): string | undefined {
  const title = value.trim();
  if (title.length === 0) return "Give the mission a name";
  if (title.length > MAX_MISSION_TITLE_LENGTH) return `Mission names can be at most ${MAX_MISSION_TITLE_LENGTH} characters`;
  return undefined;
}

export function normalizeMissionTitle(value: string): string {
  return value.trim();
}

type DuplicateResponse = { missionId: string };
type DeleteResponse = { ok: boolean };

export interface MissionActionsController {
  rename: UseMutationResult<MissionSummary, Error, string, unknown>;
  duplicate: UseMutationResult<DuplicateResponse, Error, void, unknown>;
  remove: UseMutationResult<DeleteResponse, Error, void, unknown>;
  exporting: boolean;
  exportError: string | null;
  clearExportError(): void;
  exportProject(): Promise<void>;
}

interface UseMissionActionsOptions {
  missionId: string;
  title: string;
  /** Header actions delete the currently open mission; sidebar actions leave the current page in place. */
  navigateAfterDelete?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

/** All mission mutations live here so header and sidebar actions cannot drift apart. */
export function useMissionActions({ missionId, title, navigateAfterDelete = true }: UseMissionActionsOptions): MissionActionsController {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const refreshMissions = useCallback(() => {
    void qc.invalidateQueries({ queryKey: queryKeys.missions });
  }, [qc]);
  const updateMissionList = useCallback((update: (missions: MissionSummary[]) => MissionSummary[]) => {
    qc.setQueryData<MissionSummary[]>(queryKeys.missions, (missions) => (missions ? update(missions) : missions));
  }, [qc]);

  const rename = useMutation<MissionSummary, Error, string>({
    mutationFn: (next) => sendJson<MissionSummary>("PATCH", `/api/missions/${encodeURIComponent(missionId)}`, { title: next }),
    onSuccess: (summary) => {
      updateMissionList((missions) => missions.map((mission) => mission.id === missionId ? summary : mission));
      refreshMissions();
      void qc.invalidateQueries({ queryKey: queryKeys.mission(missionId) });
    },
    onSettled: refreshMissions,
  });

  const duplicate = useMutation<DuplicateResponse, Error, void>({
    mutationFn: () => sendJson<DuplicateResponse>("POST", `/api/missions/${encodeURIComponent(missionId)}/duplicate`),
    onSuccess: ({ missionId: copyId }) => {
      refreshMissions();
      navigate(`/m/${encodeURIComponent(copyId)}`);
    },
  });

  const remove = useMutation<DeleteResponse, Error, void>({
    mutationFn: () => sendJson<DeleteResponse>("DELETE", `/api/missions/${encodeURIComponent(missionId)}`),
    onSuccess: () => {
      updateMissionList((missions) => missions.filter((mission) => mission.id !== missionId));
      refreshMissions();
      void qc.removeQueries({ queryKey: queryKeys.mission(missionId) });
      if (navigateAfterDelete) navigate("/");
    },
  });

  const exportProject = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadProject(missionId, title);
    } catch (error) {
      setExportError(errorText(error));
    } finally {
      setExporting(false);
    }
  }, [missionId, title]);

  return {
    rename,
    duplicate,
    remove,
    exporting,
    exportError,
    clearExportError: () => setExportError(null),
    exportProject,
  };
}

export interface MissionActionsProps {
  missionId: string;
  title: string;
  actions: MissionActionsController;
  /** Called after the shared menu closes. Header uses this to keep title-click editing. */
  onRename(): void;
  /** Header-only menu entries such as Bench and Phone link. */
  extraItems?: (closeMenu: () => void) => ReactNode;
  buttonLabel?: string;
  triggerSx?: SxProps<Theme>;
}

/** Shared ⋯ menu used by the open-mission header and every sidebar mission row. */
export function MissionActions({ title, actions, onRename, extraItems, buttonLabel = `Actions for ${title}`, triggerSx }: MissionActionsProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeMenu = () => setMenuAnchor(null);
  const displayTitle = title || "Untitled mission";
  const deleteError = actions.remove.isError ? errorText(actions.remove.error) : null;

  return (
    <>
      <Tooltip title={buttonLabel} describeChild>
        <IconButton
          className="mission-actions-trigger"
          size="small"
          aria-label={buttonLabel}
          onClick={(event) => setMenuAnchor(event.currentTarget)}
          sx={triggerSx}
        >
          <MoreHorizIcon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
        <MenuItem disabled={actions.duplicate.isPending} onClick={() => { closeMenu(); actions.duplicate.mutate(); }}>
          <ListItemIcon>{actions.duplicate.isPending ? <CircularProgress size={18} /> : <ContentCopyIcon fontSize="small" />}</ListItemIcon>
          <ListItemText primary={actions.duplicate.isPending ? "Duplicating…" : "Duplicate"} secondary="Make an independent copy" />
        </MenuItem>
        <MenuItem disabled={actions.exporting} onClick={() => { closeMenu(); void actions.exportProject(); }}>
          <ListItemIcon>{actions.exporting ? <CircularProgress size={18} /> : <DownloadIcon fontSize="small" />}</ListItemIcon>
          <ListItemText primary={actions.exporting ? "Preparing project file…" : "Export project (.vibread)"} secondary="Open it in ViBread on any computer" />
        </MenuItem>
        {extraItems?.(closeMenu)}
        <MenuItem onClick={() => { closeMenu(); onRename(); }}>
          <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Rename" />
        </MenuItem>
        <MenuItem onClick={() => { closeMenu(); actions.remove.reset(); setConfirmDelete(true); }}>
          <ListItemIcon><DeleteOutlinedIcon fontSize="small" color="error" /></ListItemIcon>
          <ListItemText primary="Delete…" slotProps={{ primary: { sx: { color: "error.main" } } }} />
        </MenuItem>
      </Menu>
      <Dialog open={confirmDelete} onClose={() => { if (!actions.remove.isPending) setConfirmDelete(false); }}>
        <DialogTitle>Delete “{displayTitle}”?</DialogTitle>
        <DialogContent>
          <Typography>This removes the mission's design versions, chat, build progress, and bench results. Your inventory stays as it is.</Typography>
          {deleteError && <Alert severity="error" sx={{ mt: 1.5 }}>Couldn't delete: {deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={actions.remove.isPending} onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button color="error" variant="contained" disabled={actions.remove.isPending} onClick={() => actions.remove.mutate()}>
            {actions.remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={Boolean(actions.exportError)} autoHideDuration={7000} onClose={actions.clearExportError}>
        <Alert severity="error" onClose={actions.clearExportError}>Couldn't export the project: {actions.exportError}</Alert>
      </Snackbar>
      <Snackbar open={actions.duplicate.isError} autoHideDuration={7000} onClose={() => actions.duplicate.reset()}>
        <Alert severity="error" onClose={() => actions.duplicate.reset()}>Couldn't duplicate the mission: {errorText(actions.duplicate.error)}</Alert>
      </Snackbar>
    </>
  );
}
