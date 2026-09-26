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
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { InventoryView, MissionPhase, MissionSummary } from "@vibread/core";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "../api/client.js";
import { useConnections, useMissions } from "../api/hooks.js";

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
  const item = (
    <ListItemButton
      component={RouterLink}
      to={`/m/${encodeURIComponent(mission.id)}`}
      selected={active}
      aria-label={`${mission.title} · ${dot.label}`}
      sx={{
        minHeight: 42,
        px: collapsed ? 1.5 : 1.75,
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
          primary={mission.title || "Untitled mission"}
          secondary={dot.label}
          slotProps={{ primary: { noWrap: true, sx: { fontSize: "0.9rem" } }, secondary: { noWrap: true, sx: { color: "text.secondary", fontSize: "0.72rem" } } }}
          sx={{ minWidth: 0, ml: 1 }}
        />
      )}
    </ListItemButton>
  );
  return collapsed ? <Tooltip title={`${mission.title} · ${dot.label}`} placement="right">{item}</Tooltip> : item;
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
  const claudeReady = connections.data?.claude?.using !== "none";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

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
          <Button component={RouterLink} to="/" variant="contained" color="primary" startIcon={<AddIcon />} fullWidth sx={{ justifyContent: "flex-start", px: 1.75 }}>New mission <Typography component="span" sx={{ ml: "auto", opacity: 0.7, fontSize: "0.75rem", fontWeight: 500 }}>⌘N</Typography></Button>
        )}
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
            sx={{ width: "100%", justifyContent: collapsed ? "center" : "flex-start", overflow: "hidden", "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" } }}
          />
        </Tooltip>
        <SidebarButton collapsed={collapsed} label="Settings" icon={<SettingsOutlinedIcon />} to="/settings" active={location.pathname === "/settings"} />
        {!collapsed && <Typography variant="caption" sx={{ px: 1, color: "text.secondary" }}>⌘N new mission</Typography>}
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
