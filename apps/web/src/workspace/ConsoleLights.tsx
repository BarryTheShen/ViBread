import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import WarningIcon from "@mui/icons-material/Warning";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { CONSOLE_IDS, CONSOLE_LABELS, type ConsoleId, type ConsoleReport, type Finding } from "@vibread/core";
import { useState, type ReactElement, type ReactNode } from "react";
import { VERDICT_STYLE, VerdictChip } from "../components/VerdictChip.js";
import { MONO_FONT } from "../theme.js";

const SEVERITY_ICON: Record<Finding["severity"], ReactElement> = {
  error: <ErrorIcon color="error" titleAccess="Problem" />,
  warning: <WarningIcon color="warning" titleAccess="Warning" />,
  info: <InfoIcon color="info" titleAccess="Note" />,
};

/** Go/No-Go console strip: plain label first, console name as flavor, verdict as text + icon. */
export function ConsoleLights({ reports, action }: { reports: ConsoleReport[]; action?: ReactNode }) {
  const [openId, setOpenId] = useState<ConsoleId | null>(null);
  const byId = new Map(reports.map((r) => [r.console, r]));
  const open = openId ? byId.get(openId) : undefined;
  return (
    <Box
      component="section"
      aria-label="Go/No-Go consoles"
      sx={{ display: "flex", gap: 1, px: 1.5, py: 1, borderTop: 1, borderColor: "divider", bgcolor: "#0b1118", overflowX: "auto" }}
    >
      {CONSOLE_IDS.map((id) => {
        const report = byId.get(id);
        const style = VERDICT_STYLE[report?.verdict ?? "NONE"];
        return (
          <ButtonBase
            key={id}
            onClick={() => setOpenId(id)}
            aria-label={`${CONSOLE_LABELS[id]} (${id}): ${style.label}. Show details`}
            sx={{
              flex: "1 0 180px",
              justifyContent: "flex-start",
              gap: 1,
              px: 1.25,
              py: 0.75,
              borderRadius: 1,
              border: 1,
              borderColor: report?.verdict === "NO-GO" ? "error.main" : report?.verdict === "GO" ? "success.dark" : "divider",
              textAlign: "left",
              minHeight: 48,
            }}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }} noWrap>
                {CONSOLE_LABELS[id]}
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary", letterSpacing: "0.1em" }}>
                {id}
              </Typography>
            </Box>
            <VerdictChip verdict={report?.verdict} />
          </ButtonBase>
        );
      })}
      {action && <Box sx={{ display: "flex", alignItems: "center", pl: 1, borderLeft: 1, borderColor: "divider" }}>{action}</Box>}
      <Dialog open={openId !== null} onClose={() => setOpenId(null)} maxWidth="sm" fullWidth>
        {openId && (
          <>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <span>
                {CONSOLE_LABELS[openId]} <Typography component="span" sx={{ fontFamily: MONO_FONT, color: "text.secondary" }}>· {openId}</Typography>
              </span>
              <VerdictChip verdict={open?.verdict} />
            </DialogTitle>
            <DialogContent dividers>
              {!open ? (
                <Typography>This console hasn't voted yet. It runs when the agent proposes a design.</Typography>
              ) : (
                <>
                  <Typography sx={{ mb: 1 }}>{open.summary}</Typography>
                  {open.findings.length === 0 ? (
                    <Typography sx={{ color: "text.secondary" }}>No problems found.</Typography>
                  ) : (
                    <List dense>
                      {open.findings.map((f, i) => (
                        <ListItem key={`${f.ruleId}-${i}`} sx={{ alignItems: "flex-start" }}>
                          <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>{SEVERITY_ICON[f.severity]}</ListItemIcon>
                          <ListItemText
                            primary={f.title}
                            secondary={
                              <>
                                {f.fix && <Box component="span" sx={{ display: "block" }}>What to change: {f.fix}</Box>}
                                {f.detail && <Box component="span" sx={{ display: "block", fontFamily: MONO_FONT, fontSize: 12, mt: 0.5 }}>{f.detail}</Box>}
                                <Box component="span" sx={{ display: "block", fontFamily: MONO_FONT, fontSize: 11, mt: 0.5 }}>rule {f.ruleId}</Box>
                              </>
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  )}
                  <Typography variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary" }}>
                    design {open.revisionHash.slice(0, 10)} · {new Date(open.at).toLocaleString()}
                  </Typography>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setOpenId(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
