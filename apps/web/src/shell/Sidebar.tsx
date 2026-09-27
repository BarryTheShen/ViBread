import AddIcon from "@mui/icons-material/Add";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import CircleOutlinedIcon from "@mui/icons-material/CircleOutlined";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { InventoryView, MissionPhase, MissionSummary } from "@vibread/core";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "../api/client.js";
import { ProjectImportButton } from "../project/ProjectImportButton.js";
import { WEB_VERSION } from "../version.js";
import { useConnections, useMissions } from "../api/hooks.js";
import { MissionActions, normalizeMissionTitle, useMissionActions, validateMissionTitle } from "../workspace/MissionActions.js";
const COLLAPSED_KEY = "vibread.sidebar.collapsed";
const SIDEBAR_WIDTH = 260;
const COLLAPSED_WIDTH = 72;

const PHASE_DOTS: Record<MissionPhase, { glyph: string; color: "primary" | "warning" | "info" | "secondary" | "success"; label: string }> = {
  BRIEF: { glyph: "●", color: "primary", label: "Designing" },
  CLARIFY: { glyph: "●", color: "primary", label: "Designing" },
  DESIGN: { glyph: "●", color: "primary", label: "Designing" },
  GONOGO: { glyph: "◐", color: "warning", label: "Ready for GO" },
  ASSEMBLE: { glyph: "▲", color: "info", label: "Building" },
  VERIFY: { glyph: "◆", color: "secondary", label: "Testing" },
  DEBUG: { glyph: "◆", color: "secondary", label: "Testing" },
  LAUNCH: { glyph: "★", color: "success", label: "Launched" },
  DONE: { glyph: "✓", color: "success", label: "Done" },
};

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return Number.isFinite(date.getTime()) && date.toDateString() === now.toDateString();
}

function readCollapsed(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(COLLAPSED_KEY) === "true";
}

function SidebarButton({
  collapsed,
  label,
  icon,
  to,
  active,
  badge,
}: {
  collapsed: boolean;
  label: string;
  icon: React.ReactNode;
  to: string;
  active: boolean;
  badge?: number | null;
}) {
  const item = (
    <ListItemButton
      component={RouterLink}
      to={to}
      selected={active}
      aria-label={collapsed ? label : undefined}
      sx={{
        minHeight: 44,
        px: collapsed ? 1.5 : 1.75,
        borderRadius: 2,
        justifyContent: collapsed ? "center" : "flex-start",
        color: "text.primary",
        "&.Mui-selected": { bgcolor: "action.selected", color: "primary.main" },
        "&.Mui-selected:hover": { bgcolor: "action.hover" },
      }}
    >
      <ListItemIcon sx={{ minWidth: collapsed ? 0 : 38, color: "inherit", justifyContent: "center" }}>{icon}</ListItemIcon>
      {!collapsed && <ListItemText primary={label} />}
      {!collapsed && badge !== undefined && badge !== null && <Chip size="small" label={badge} sx={{ height: 24, minWidth: 28 }} />}
    </ListItemButton>
  );
  return collapsed ? <Tooltip title={label} placement="right">{item}</Tooltip> : item;
}

function MissionItem({ mission, collapsed }: { mission: MissionSummary; collapsed: boolean }) {
  const location = useLocation();
  const active = location.pathname === `/m/${mission.id}`;
  const dot = PHASE_DOTS[mission.phase];
  const statusLabel = (mission.phase === "BRIEF" || mission.phase === "CLARIFY" || mission.phase === "DESIGN")
    ? (mission.agentBusy ? "Designing…" : "Waiting for you")
    : dot.label;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mission.title);
  const [validationError, setValidationError] = useState<string | null>(null);
  const actions = useMissionActions({ missionId: mission.id, title: mission.title, navigateAfterDelete: active });
  const displayTitle = mission.title || "Untitled mission";
  const mutationError = actions.rename.isError
    ? actions.rename.error instanceof Error ? actions.rename.error.message : "Couldn't rename the mission"
    : null;

  const startRename = () => {
    actions.rename.reset();
    setDraft(mission.title);
    setValidationError(null);
    setEditing(true);
  };
  const cancelRename = () => {
    actions.rename.reset();
    setDraft(mission.title);
    setValidationError(null);
    setEditing(false);
  };
  const commitRename = () => {
    const next = normalizeMissionTitle(draft);
    const error = validateMissionTitle(next);
    if (error) {
      setValidationError(error);
      return;
    }
    if (next === mission.title) {
      cancelRename();
      return;
    }
    setValidationError(null);
    actions.rename.mutate(next, {
      onSuccess: () => setEditing(false),
    });
  };

  const item = editing ? (
    <Box sx={{ px: collapsed ? 0.25 : 0.5, py: 0.25 }}>
      <TextField
        autoFocus
        fullWidth
        size="small"
        value={draft}
        error={Boolean(validationError || mutationError)}
        helperText={validationError || mutationError || " "}
        onChange={(event) => {
          setDraft(event.target.value);
          if (validationError) setValidationError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRename();
          }
        }}
        slotProps={{ htmlInput: { maxLength: 80, "aria-label": `Rename ${displayTitle}` } }}
      />
    </Box>
  ) : (
    <Box
      sx={{
        position: "relative",
        minWidth: 0,
        "& .mission-actions-trigger": { opacity: 0, pointerEvents: "none" },
        "&:hover .mission-actions-trigger, &:focus-within .mission-actions-trigger": { opacity: 1, pointerEvents: "auto" },
        "@media (hover: none)": { "& .mission-actions-trigger": { opacity: 1, pointerEvents: "auto" } },
      }}
    >
      <ListItemButton
        component={RouterLink}
        to={`/m/${encodeURIComponent(mission.id)}`}
        selected={active}
        aria-label={`${displayTitle} · ${statusLabel}`}
        sx={{
          minHeight: 42,
          px: collapsed ? 1.5 : 1.75,
          pr: collapsed ? 1.5 : 5.5,
          borderRadius: 2,
          justifyContent: collapsed ? "center" : "flex-start",
          color: "text.primary",
          "&.Mui-selected": { bgcolor: "action.selected" },
          "&.Mui-selected:hover": { bgcolor: "action.hover" },
        }}
      >
        <Box component="span" aria-hidden sx={{ color: `${dot.color}.main`, fontSize: 18, lineHeight: 1, width: collapsed ? "auto" : 22, textAlign: "center", flexShrink: 0 }}>
          {dot.glyph}
        </Box>
        {!collapsed && (
          <ListItemText
            primary={displayTitle}
            secondary={statusLabel}
            slotProps={{ primary: { noWrap: true, sx: { fontSize: "0.9rem" } }, secondary: { noWrap: true, sx: { color: "text.secondary", fontSize: "0.72rem" } } }}
            sx={{ minWidth: 0, ml: 1 }}
          />
        )}
      </ListItemButton>
      <MissionActions
        missionId={mission.id}
        title={mission.title}
        actions={actions}
        onRename={startRename}
        buttonLabel={`Actions for ${displayTitle}`}
        triggerSx={{ position: "absolute", right: collapsed ? 0 : 4, top: "50%", transform: "translateY(-50%)" }}
      />
    </Box>
  );
  return collapsed ? <Tooltip title={`${displayTitle} · ${statusLabel}`} placement="right">{item}</Tooltip> : item;
}

function MissionGroup({ title, missions, collapsed }: { title: string; missions: MissionSummary[]; collapsed: boolean }) {
  if (missions.length === 0) return null;
  return (
    <Box sx={{ mb: 1.5 }}>
      {!collapsed && <Typography variant="overline" sx={{ display: "block", px: 1.75, py: 0.75, color: "text.secondary" }}>{title}</Typography>}
      <List disablePadding sx={{ display: "grid", gap: 0.25 }}>{missions.map((mission) => <MissionItem key={mission.id} mission={mission} collapsed={collapsed} />)}</List>
    </Box>
  );
}

function inventoryCount(value: InventoryView | undefined): number | null {
  if (!value) return null;
  return value.entries.reduce((sum, entry) => sum + Math.max(0, entry.quantity), 0);
}

export interface SidebarProps {
  collapsed: boolean;
  onToggle(): void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const missions = useMissions();
  const connections = useConnections();
  const inventory = useQuery({
    queryKey: ["inventory", "sidebar"],
    queryFn: ({ signal }) => getJson<InventoryView>("/api/inventory", signal),
    staleTime: 30_000,
    retry: false,
  });
  const grouped = useMemo(() => {
    const list = missions.data ?? [];
    return {
      today: list.filter((mission) => isToday(mission.updatedAt)),
      earlier: list.filter((mission) => !isToday(mission.updatedAt)),
    };
  }, [missions.data]);
  const claudeReady = connections.data ? connections.data.claude.using !== "none" : undefined;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const newMissionShortcut = isMac ? "⌘N" : "Ctrl+N";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac, navigate]);

  return (
    <Box
      component="aside"
      aria-label="Mission navigation"
      sx={{
        width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH,
        flexShrink: 0,
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.sidebar",
        transition: "width 160ms ease",
        overflow: "hidden",
      }}
    >
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: collapsed ? "center" : "space-between", px: collapsed ? 1 : 1.75, py: 1.5, minHeight: 64 }}>
        {!collapsed && <Typography component={RouterLink} to="/" variant="h6" sx={{ color: "text.primary", textDecoration: "none", letterSpacing: "-0.02em" }}>ViBread</Typography>}
        <Tooltip title={collapsed ? "Expand sidebar" : "Collapse sidebar"} placement={collapsed ? "right" : "bottom"}>
          <IconButton size="small" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}>
            {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ px: collapsed ? 1 : 1.25, pb: 1.25 }}>
        {collapsed ? (
          <Tooltip title="New mission" placement="right">
            <IconButton component={RouterLink} to="/" color="primary" aria-label="New mission" sx={{ width: "100%", border: 1, borderColor: "primary.main", borderRadius: 2 }}><AddIcon /></IconButton>
          </Tooltip>
        ) : (
          <Button component={RouterLink} to="/" variant="contained" color="primary" startIcon={<AddIcon />} fullWidth sx={{ justifyContent: "flex-start", px: 1.75 }}>New mission <Typography component="span" sx={{ ml: "auto", opacity: 0.7, fontSize: "0.75rem", fontWeight: 500 }}>{newMissionShortcut}</Typography></Button>
        )}
      </Box>
      <Box sx={{ mt: 0.25, px: collapsed ? 1 : 1.25 }}>
        <ProjectImportButton collapsed={collapsed} />
      </Box>

      <List disablePadding sx={{ px: collapsed ? 1 : 1.25, display: "grid", gap: 0.25 }}>
        <SidebarButton collapsed={collapsed} label="Inventory" icon={<Inventory2OutlinedIcon />} to="/inventory" active={location.pathname.startsWith("/inventory")} badge={inventoryCount(inventory.data)} />
      </List>
      <Divider sx={{ mx: collapsed ? 1 : 1.75, my: 1 }} />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: collapsed ? 1 : 1.25 }}>
        {missions.isPending ? (
          <Stack sx={{ gap: 1, px: collapsed ? 0.5 : 0.5 }}>
            <Skeleton variant="rounded" height={16} width={collapsed ? 24 : 82} />
            <Skeleton variant="rounded" height={42} />
            <Skeleton variant="rounded" height={42} />
          </Stack>
        ) : missions.data?.length ? (
          <>
            <MissionGroup title="Today" missions={grouped.today} collapsed={collapsed} />
            <MissionGroup title="Earlier" missions={grouped.earlier} collapsed={collapsed} />
          </>
        ) : (
          !collapsed && <Typography variant="body2" sx={{ px: 0.5, py: 1, color: "text.secondary" }}>No missions yet.</Typography>
        )}
      </Box>

      <Box sx={{ px: collapsed ? 1 : 1.25, pb: 1.25, display: "grid", gap: 0.5 }}>
        {claudeReady === undefined ? (
          <Skeleton variant="rounded" height={30} sx={{ width: "100%" }} aria-label="Loading Claude connection" />
        ) : (
          <Tooltip title={claudeReady ? "Claude ready" : "Claude not connected · Connect"} placement={collapsed ? "right" : "top"}>
            <Chip
              component={RouterLink}
              to="/settings"
              clickable
              icon={claudeReady ? <CheckCircleOutlinedIcon /> : <CircleOutlinedIcon />}
              color={claudeReady ? "success" : "default"}
              variant={claudeReady ? "outlined" : "filled"}
              label={collapsed ? undefined : claudeReady ? "Claude ready" : "Claude not connected · Connect"}
              aria-label={claudeReady ? "Claude ready" : "Claude not connected. Connect"}
              sx={{ width: "100%", minHeight: 30, height: "auto", py: 0.5, justifyContent: collapsed ? "center" : "flex-start", "& .MuiChip-label": { whiteSpace: "normal", overflow: "visible", textOverflow: "clip", lineHeight: 1.2, textAlign: "left" } }}
            />
          </Tooltip>
        )}
        <SidebarButton collapsed={collapsed} label="Settings" icon={<SettingsOutlinedIcon />} to="/settings" active={location.pathname === "/settings"} />
        {!collapsed && <Typography variant="caption" sx={{ px: 1, color: "text.secondary" }}>{newMissionShortcut} new mission · v{WEB_VERSION.version}</Typography>}
      </Box>
    </Box>
  );
}

export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const set = (next: boolean) => {
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, String(next));
  };
  return [collapsed, set];
}
