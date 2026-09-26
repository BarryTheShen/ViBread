import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import Alert from "@mui/material/Alert";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { PhotoPartAnswer, RevisionDetail } from "@vibread/core";
import type { ReactElement } from "react";

const ANSWER: Record<PhotoPartAnswer["status"], { word: string; icon: ReactElement }> = {
  correct: { word: "Looks right", icon: <CheckCircleIcon color="success" fontSize="small" /> },
  wrong: { word: "Looks wrong", icon: <CancelIcon color="error" fontSize="small" /> },
  missing: { word: "Can't find it", icon: <RemoveCircleOutlineIcon color="warning" fontSize="small" /> },
  unknown: { word: "Can't tell", icon: <HelpOutlineIcon sx={{ color: "text.secondary" }} fontSize="small" /> },
};

export function PhotoTab({ revision }: { revision: RevisionDetail }) {
  const photos = revision.results.photos ?? [];
  const latest = photos[photos.length - 1];
  if (!latest) {
    return <Alert severity="info">No photo checks yet. In Build Mode on your phone, tap "Check with camera" after a step.</Alert>;
  }
  return (
    <Stack sx={{ gap: 2 }}>
      <Typography variant="h6" component="h2">
        Latest photo check · step {latest.step}
      </Typography>
      <Alert severity="info">
        A photo check is advice only. The self-test over USB is what proves the wiring works.
      </Alert>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography sx={{ mb: 1 }}>{latest.summary}</Typography>
        <List dense disablePadding>
          {latest.answers.map((a) => (
            <ListItem key={a.part} disableGutters sx={{ alignItems: "flex-start" }}>
              <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>{ANSWER[a.status].icon}</ListItemIcon>
              <ListItemText primary={`${a.part}: ${ANSWER[a.status].word}`} secondary={a.note} />
            </ListItem>
          ))}
        </List>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Checked by {latest.model} · {photos.length} photo check{photos.length === 1 ? "" : "s"} on this design
        </Typography>
      </Paper>
    </Stack>
  );
}
