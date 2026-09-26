import BuildIcon from "@mui/icons-material/Build";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import PlayCircleIcon from "@mui/icons-material/PlayCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import UsbIcon from "@mui/icons-material/Usb";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { MISSION_PHASES, type MissionPhase, type TimelineEvent } from "@vibread/core";
import { Link as RouterLink } from "react-router";
import { agoLabel, useNow } from "../lib/time.js";

/** Plain labels for the mission lifecycle (PLAN §5.4); the phase code is secondary. */
export const PHASE_COPY: Record<MissionPhase, { label: string; hint: string }> = {
  BRIEF: { label: "Describe it", hint: "Tell ViBread what the circuit should do" },
  CLARIFY: { label: "Questions", hint: "The agent checks anything unclear" },
  DESIGN: { label: "Design", hint: "Circuit, code, and tests are drafted" },
  GONOGO: { label: "Go/No-Go checks", hint: "Every console votes before you build" },
  ASSEMBLE: { label: "Build it", hint: "Place parts step by step" },
  VERIFY: { label: "Test the real board", hint: "Self-test over USB at the bench" },
  DEBUG: { label: "Fix a problem", hint: "Only if a test fails" },
  LAUNCH: { label: "Launch", hint: "Your real sketch runs" },
  DONE: { label: "Done", hint: "Mission complete" },
};

export function PhaseDrawer({ missionId, phase, timeline }: { missionId: string; phase: MissionPhase; timeline: TimelineEvent[] }) {
  const now = useNow(30_000);
  const currentIndex = MISSION_PHASES.indexOf(phase);
  const recent = timeline.slice(-6).reverse();
  return (
    <Box component="nav" aria-label="Mission steps" sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto" }}>
      <Typography variant="overline" sx={{ px: 2, pt: 2, color: "text.secondary" }}>
        Mission steps
      </Typography>
      <List dense>
        {MISSION_PHASES.map((p, i) => {
          if (p === "DEBUG" && phase !== "DEBUG") return null;
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "next";
          return (
            <ListItem key={p} aria-current={state === "current" ? "step" : undefined} sx={{ py: 0.25 }}>
              <ListItemIcon sx={{ minWidth: 34 }}>
                {state === "done" ? (
                  <CheckCircleIcon color="success" fontSize="small" titleAccess="Done" />
                ) : state === "current" ? (
                  <PlayCircleIcon color="primary" fontSize="small" titleAccess="Now" />
                ) : (
                  <RadioButtonUncheckedIcon fontSize="small" sx={{ color: "text.disabled" }} titleAccess="Not yet" />
                )}
              </ListItemIcon>
              <ListItemText
                primary={PHASE_COPY[p].label}
                secondary={state === "current" ? `Now · ${PHASE_COPY[p].hint}` : state === "done" ? "Done" : undefined}
                slotProps={{
                  primary: { sx: { fontWeight: state === "current" ? 700 : 500, color: state === "next" ? "text.secondary" : "text.primary" } },
                }}
              />
            </ListItem>
          );
        })}
      </List>
      <Divider />
      <List dense>
        <ListItemButton component={RouterLink} to={`/m/${missionId}/bench`}>
          <ListItemIcon sx={{ minWidth: 34 }}>
            <UsbIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Open the bench" secondary="Flash and self-test (this laptop)" />
        </ListItemButton>
        <ListItemButton component={RouterLink} to={`/b/${missionId}`}>
          <ListItemIcon sx={{ minWidth: 34 }}>
            <PhoneIphoneIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Build Mode" secondary="Step-by-step view for your phone" />
        </ListItemButton>
      </List>
      {recent.length > 0 && (
        <>
          <Divider />
          <Typography variant="overline" sx={{ px: 2, pt: 1.5, color: "text.secondary" }}>
            Latest activity
          </Typography>
          <List dense sx={{ pb: 2 }}>
            {recent.map((e) => (
              <ListItem key={e.id} sx={{ alignItems: "flex-start", py: 0.25 }}>
                <ListItemIcon sx={{ minWidth: 34, mt: 0.5 }}>
                  <BuildIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                </ListItemIcon>
                <ListItemText
                  primary={e.text}
                  secondary={`${agoLabel(e.at, now)} · ${e.actor.name ?? e.actor.kind} via ${e.channel}`}
                  slotProps={{ primary: { sx: { fontSize: 13 } }, secondary: { sx: { fontSize: 12 } } }}
                />
              </ListItem>
            ))}
          </List>
        </>
      )}
    </Box>
  );
}
