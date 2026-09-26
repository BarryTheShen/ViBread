import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import PowerIcon from "@mui/icons-material/Power";
import PowerOffIcon from "@mui/icons-material/PowerOff";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { RevisionDetail } from "@vibread/core";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useConnections } from "../../api/hooks.js";

/**
 * Phones can't open `localhost`: when the laptop is on localhost, point the QR at the server's public URL
 * (the MCP URL's origin from GET /api/connections) instead.
 */
function usePhoneOrigin(): string {
  const connections = useConnections();
  const here = window.location.origin;
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  if (!local || !connections.data?.mcpUrl) return here;
  try {
    return new URL(connections.data.mcpUrl).origin;
  } catch {
    return here;
  }
}

export function StepsTab({ missionId, revision, released }: { missionId: string; revision: RevisionDetail; released: boolean }) {
  const steps = revision.results.steps?.steps ?? [];
  const [index, setIndex] = useState(0);
  const phoneUrl = `${usePhoneOrigin()}/b/${missionId}`;
  useEffect(() => setIndex(0), [revision.n]);

  if (steps.length === 0) {
    return <Alert severity="info">Build steps appear here once the design passes its checks and is laid out on the breadboard.</Alert>;
  }
  const step = steps[Math.min(index, steps.length - 1)];
  const image = revision.artifactUrls[`step-${step.n}.svg`] ?? revision.artifactUrls[`step-${step.n}.png`];
  return (
    <Stack sx={{ gap: 2 }}>
      {!released && (
        <Alert severity="warning">
          Preview only: this design isn't the build target yet. Build Mode on your phone follows the released design.
        </Alert>
      )}
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Button startIcon={<NavigateBeforeIcon />} disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
          Previous
        </Button>
        <Typography sx={{ flex: 1, textAlign: "center", fontWeight: 600 }} aria-live="polite">
          Step {step.n} of {steps.length}
        </Typography>
        <Button endIcon={<NavigateNextIcon />} disabled={index >= steps.length - 1} onClick={() => setIndex((i) => i + 1)}>
          Next
        </Button>
      </Stack>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1 }}>
          <Typography variant="h3" component="h2" sx={{ flex: 1 }}>
            {step.title}
          </Typography>
          <Chip
            icon={step.plug === "plugged" ? <PowerIcon /> : <PowerOffIcon />}
            color={step.plug === "plugged" ? "warning" : "default"}
            variant="outlined"
            label={step.plug === "plugged" ? "USB plugged in" : "USB unplugged"}
          />
        </Stack>
        {image ? (
          <Box
            component="img"
            src={image}
            alt={`Breadboard for step ${step.n}: ${step.title}`}
            sx={{ display: "block", width: "100%", maxHeight: "48vh", objectFit: "contain", bgcolor: "#0a0f14", borderRadius: 1 }}
          />
        ) : (
          <Alert severity="info">No picture for this step.</Alert>
        )}
        <Typography sx={{ mt: 1.5 }}>{step.text}</Typography>
        {step.callouts.length > 0 && (
          <List dense disablePadding sx={{ mt: 1 }}>
            {step.callouts.map((c) => (
              <ListItem key={c} disableGutters>
                <ListItemText primary={c} />
              </ListItem>
            ))}
          </List>
        )}
        {step.checkpoint && (
          <Alert severity="info" sx={{ mt: 1 }}>
            Checkpoint: {step.checkpoint.text}
          </Alert>
        )}
      </Paper>
      <Paper variant="outlined" sx={{ p: 2, display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ bgcolor: "#fff", p: 1, borderRadius: 1, lineHeight: 0 }}>
          <QRCodeSVG value={phoneUrl} size={120} title="QR code for Build Mode on your phone" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography sx={{ fontWeight: 600 }}>Follow along on your phone</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 0.5 }}>
            Scan to open Build Mode: one step at a time, next to your breadboard. Flashing always stays on this laptop.
          </Typography>
          <Link href={phoneUrl} sx={{ wordBreak: "break-all" }}>
            {phoneUrl}
          </Link>
        </Box>
      </Paper>
    </Stack>
  );
}
