import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import WarningIcon from "@mui/icons-material/Warning";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { CONSOLE_IDS, CONSOLE_LABELS, type ConsoleId, type ConsoleReport, type Finding } from "@vibread/core";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { RecordedChip } from "../../components/RecordedChip.js";
import { VerdictChip } from "../../components/VerdictChip.js";
import { isRecord } from "../../lib/guards.js";
import { MONO_FONT } from "../../theme.js";

const SEVERITY_ICON: Record<Finding["severity"], ReactElement> = {
  error: <ErrorIcon color="error" titleAccess="Problem" />,
  warning: <WarningIcon color="warning" titleAccess="Warning" />,
  info: <InfoIcon color="info" titleAccess="Note" />,
};

/** What each check does, in plain words (shown under its name). */
const WHAT_IT_CHECKS: Record<ConsoleId, string> = {
  EECOM: "Wiring, current and voltage limits: nothing gets too hot or too much current.",
  GUIDO: "The Arduino sketch compiles and matches the pins in the design.",
  FIDO: "The sketch runs in a simulator and passes its behaviour tests.",
  FAO: "Every part fits on the breadboard and the steps can be built.",
  RETRO: "An independent AI review of the whole design.",
};

/** RETRO votes replayed from a recorded run carry `evidence.recorded.label`; they must never look like a live vote. */
function recordedVoteOf(report: ConsoleReport | undefined): string | undefined {
  const recorded = report?.evidence?.recorded;
  return isRecord(recorded) && typeof recorded.label === "string" ? recorded.label : undefined;
}

/** On an older design, a check with no result (or still "waiting") never runs: the newer design replaced it. */
export function isSupersededCheck(report: ConsoleReport | undefined, supersededBy: number | undefined): boolean {
  return supersededBy !== undefined && (report === undefined || report.verdict === "PENDING");
}

function Findings({ id, report, supersededBy }: { id: ConsoleId; report: ConsoleReport | undefined; supersededBy?: number }) {
  if (isSupersededCheck(report, supersededBy)) {
    return (
      <Typography sx={{ color: "text.secondary" }}>
        This check didn't run on this design: design r{supersededBy} replaced it first. Switch to r{supersededBy} to see its result.
      </Typography>
    );
  }
  if (!report) {
    return (
      <Typography>
        {id === "RETRO"
          ? "The independent review is done by the AI agent once the other four checks say GO. It hasn't run for this design — on this server that usually means Claude isn't connected (Settings → Connect your Claude account). You can still give GO for build yourself."
          : "This check hasn't run yet. It runs when a design is proposed."}
      </Typography>
    );
  }
  return (
    <>
      <Typography sx={{ mb: 1 }}>{report.summary}</Typography>
      {report.findings.length === 0 ? (
        <Typography sx={{ color: "text.secondary" }}>
          {report.verdict === "GO" || report.verdict === "NO-GO" ? "No problems found." : "It didn't run, so there are no findings to show."}
        </Typography>
      ) : (
        <List dense disablePadding>
          {report.findings.map((f, i) => (
            <ListItem key={`${f.ruleId}-${i}`} disableGutters sx={{ alignItems: "flex-start" }}>
              <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>{SEVERITY_ICON[f.severity]}</ListItemIcon>
              <ListItemText
                primary={f.title}
                secondary={
                  <>
                    {f.fix && (
                      <Box component="span" sx={{ display: "block" }}>
                        What to change: {f.fix}
                      </Box>
                    )}
                    {f.detail && (
                      <Box component="span" sx={{ display: "block", fontFamily: MONO_FONT, fontSize: 12, mt: 0.5 }}>
                        {f.detail}
                      </Box>
                    )}
                    <Box component="span" sx={{ display: "block", fontFamily: MONO_FONT, fontSize: 11, mt: 0.5 }}>
                      rule {f.ruleId}
                    </Box>
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
      <Typography variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary", display: "block", mt: 1 }}>
        design {report.revisionHash.slice(0, 10)} · {new Date(report.at).toLocaleString()}
      </Typography>
    </>
  );
}

/** All five checks with their findings; `focus` (from a header status dot) opens and scrolls to that check. */
/** `supersededBy`: set when this is an older design; its never-run checks then read "Not run — superseded by rN". */
export function ChecksView({ consoles, focus, supersededBy }: { consoles: ConsoleReport[]; focus?: ConsoleId; supersededBy?: number }) {
  const [expanded, setExpanded] = useState<ConsoleId | undefined>(focus);
  useEffect(() => {
    if (!focus) return;
    setExpanded(focus);
    document.getElementById(`check-${focus}`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  return (
    <Stack sx={{ gap: 1 }}>
      {CONSOLE_IDS.map((id) => {
        const report = consoles.find((c) => c.console === id);
        const warnings = report?.findings.filter((f) => f.severity === "warning").length ?? 0;
        const recorded = recordedVoteOf(report);
        return (
          <Accordion key={id} id={`check-${id}`} disableGutters variant="outlined" expanded={expanded === id} onChange={(_, open) => setExpanded(open ? id : undefined)}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls={`check-${id}-body`}>
              <Stack direction="row" sx={{ gap: 1.5, alignItems: "center", width: "100%", flexWrap: "wrap" }}>
                <Box sx={{ flex: 1, minWidth: 160 }}>
                  <Typography sx={{ fontWeight: 600 }}>
                    {CONSOLE_LABELS[id]}{" "}
                    <Typography component="span" variant="caption" sx={{ fontFamily: MONO_FONT, color: "text.secondary", letterSpacing: "0.1em" }}>
                      {id}
                    </Typography>
                  </Typography>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {WHAT_IT_CHECKS[id]}
                  </Typography>
                </Box>
                {isSupersededCheck(report, supersededBy) ? (
                  <Chip size="small" variant="outlined" icon={<RemoveCircleOutlineIcon />} label={`Not run — superseded by r${supersededBy}`} />
                ) : (
                  <VerdictChip verdict={report?.verdict} warnings={warnings} />
                )}
                {recorded && <RecordedChip label="Recorded vote" title={recorded} />}
              </Stack>
            </AccordionSummary>
            <AccordionDetails id={`check-${id}-body`}>
              <Findings id={id} report={report} supersededBy={supersededBy} />
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Stack>
  );
}
