import ArchitectureIcon from "@mui/icons-material/Architecture";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import FlagOutlinedIcon from "@mui/icons-material/FlagOutlined";
import HistoryIcon from "@mui/icons-material/History";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import MemoryIcon from "@mui/icons-material/Memory";
import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import ButtonBase from "@mui/material/ButtonBase";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import { useId, useState, type ComponentType } from "react";
import type { MissionShellValue, TimelineRowProps } from "../contracts.js";
import { describeItem, groupTimeline, type RowModel, type RowTone, type TimelineItem } from "./timeline.js";

const ICONS: Record<RowModel["icon"], ComponentType<SvgIconProps>> = {
  design: ArchitectureIcon,
  tests: ScienceOutlinedIcon,
  checks: FactCheckOutlinedIcon,
  go: RocketLaunchOutlinedIcon,
  steps: BuildCircleOutlinedIcon,
  photo: CameraAltOutlinedIcon,
  bench: MemoryIcon,
  done: TaskAltIcon,
  recorded: HistoryIcon,
  parts: Inventory2OutlinedIcon,
  phase: FlagOutlinedIcon,
  info: InfoOutlinedIcon,
};

const TONE_COLOR: Record<RowTone, string> = {
  neutral: "text.secondary",
  info: "info.main",
  success: "success.main",
  warning: "warning.main",
  error: "error.main",
};

/** One timeline row (a single event or a group of them) as a compact, expandable one-liner inside the chat. */
export function TimelineItemRow({ item, onOpenPanel }: { item: TimelineItem; onOpenPanel: MissionShellValue["openPanel"] }) {
  const row = describeItem(item);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Icon = ICONS[row.icon];
  const view = row.view;
  const expandable = row.details.length > 1 || row.recorded !== undefined || (row.details[0] !== undefined && row.details[0] !== row.title);
  const label = (
    <>
      <Icon fontSize="small" sx={{ color: TONE_COLOR[row.tone], flexShrink: 0 }} aria-hidden />
      <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }}>
        {row.title}
      </Typography>
      {row.status && (
        <Typography variant="body2" noWrap sx={{ color: row.tone === "neutral" ? "text.secondary" : TONE_COLOR[row.tone], flexShrink: 0 }}>
          · {row.status}
        </Typography>
      )}
    </>
  );
  return (
    <Box component="li" sx={{ listStyle: "none", my: 0.25 }} data-timeline-kind={item.events[0].kind}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minHeight: 32 }}>
        {view ? (
          <ButtonBase
            onClick={() => onOpenPanel(view, row.revision !== undefined ? { revision: row.revision } : undefined)}
            aria-label={`${row.title}${row.status ? `, ${row.status}` : ""}. Open in the panel`}
            sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5, borderRadius: 1, minWidth: 0, justifyContent: "flex-start", "&:hover": { bgcolor: "action.hover" } }}
          >
            {label}
          </ButtonBase>
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5, minWidth: 0 }}>{label}</Box>
        )}
        {row.recorded && row.icon !== "recorded" && (
          <Tooltip title={`${row.recorded} — replayed from a recorded real run, not live`}>
            <Chip size="small" variant="outlined" color="info" icon={<HistoryIcon />} label="Recorded" tabIndex={0} sx={{ flexShrink: 0 }} />
          </Tooltip>
        )}
        {expandable && (
          <IconButton
            size="small"
            aria-label={open ? "Hide details" : "Show details"}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
            sx={{ minWidth: 28, minHeight: 28, color: "text.secondary" }}
          >
            <ChevronRightIcon fontSize="small" sx={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
          </IconButton>
        )}
      </Box>
      {expandable && (
        <Collapse in={open} id={detailsId} unmountOnExit>
          <Box component="ul" sx={{ m: 0, mb: 0.5, pl: 5, pr: 1, color: "text.secondary" }}>
            {[...row.details, ...(row.recorded ? [row.recorded] : [])].map((line, i) => (
              <Typography key={i} component="li" variant="body2" sx={{ py: 0.25 }}>
                {line}
              </Typography>
            ))}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

/** contracts.ts TimelineRowProps: one timeline event as a chat row. */
export function TimelineRow({ event, onOpenPanel }: TimelineRowProps) {
  const item = groupTimeline([event])[0];
  return item ? <TimelineItemRow item={item} onOpenPanel={onOpenPanel} /> : null;
}

/** A run of rows between two chat messages. */
export function TimelineRows({ items, onOpenPanel }: { items: TimelineItem[]; onOpenPanel: MissionShellValue["openPanel"] }) {
  if (items.length === 0) return null;
  return (
    <Box component="ul" aria-label="Mission progress" sx={{ m: 0, p: 0, my: 1 }}>
      {items.map((item) => (
        <TimelineItemRow key={item.key} item={item} onOpenPanel={onOpenPanel} />
      ))}
    </Box>
  );
}
