import GppMaybeIcon from "@mui/icons-material/GppMaybe";
import UsbIcon from "@mui/icons-material/Usb";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ActionClass, ApprovalDecision } from "@vibread/core";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { expiryLabel, useNow } from "../lib/time.js";

export interface ApprovalCardProps {
  approvalId: string;
  /** Plain-language action ("Release revision 3 as the build target"). */
  summary: string;
  /** What happens if allowed. */
  consequence: string;
  actionClass: ActionClass;
  revisionHash?: string;
  revision?: number;
  expiresAt?: string;
  missionId: string;
  /** Set once decided (from the stream or the broker). */
  decided?: { decision: ApprovalDecision } | { status: "expired" | "consumed" };
  onDecide(decision: ApprovalDecision): Promise<void>;
  /** Tighter layout for the strip above the chat (requests from other channels). */
  dense?: boolean;
}

const CLASS_LABEL: Record<ActionClass, string> = {
  "read-only": "Look only",
  "state-changing": "Changes the design",
  release: "Build target",
  physical: "Physical action",
  "bom-change": "New part",
};

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "approve-once": "You allowed this once",
  "approve-mission": "You allowed this kind of change for the rest of the mission",
  deny: "You said no",
};

/** Inline permission card (PLAN §5.8): plain action + consequence, revision + expiry chips, three explicit choices. */
export function ApprovalCard(props: ApprovalCardProps) {
  const { summary, consequence, actionClass, revisionHash, revision, expiresAt, missionId, decided, onDecide, dense = false } = props;
  const now = useNow(10_000);
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const physical = actionClass === "physical";
  const perActionOnly = physical || actionClass === "bom-change";
  const expired = expiresAt ? Date.parse(expiresAt) <= now : false;

  async function decide(decision: ApprovalDecision) {
    setPending(decision);
    setError(null);
    try {
      await onDecide(decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  const heading = physical ? "Your go-ahead is needed at the bench" : "Permission needed";
  return (
    <Card
      variant="outlined"
      role="group"
      aria-label={`${heading}: ${summary}`}
      sx={{ borderColor: decided ? "divider" : "secondary.main", borderWidth: decided ? 1 : 2, bgcolor: "background.paper", my: 1 }}
    >
      <CardContent sx={{ pb: 1, ...(dense ? { pt: 1.5, px: 2 } : {}) }}>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 1 }}>
          {physical ? <UsbIcon color="secondary" /> : <GppMaybeIcon color="secondary" />}
          <Typography variant="overline" sx={{ color: "secondary.main", lineHeight: 1.4 }}>
            {heading}
          </Typography>
        </Stack>
        <Typography variant="h3" component="p" sx={{ mb: 0.5, ...(dense ? { fontSize: "1.05rem" } : {}) }}>
          {summary}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {consequence}
          {physical && dense && " Runs only when you click Start at the bench; allowing it here does not touch the board."}
        </Typography>
        {physical && !dense && (
          <Alert severity="info" icon={<UsbIcon />} sx={{ mt: 1.5 }}>
            This runs only when you click <strong>Start</strong> at the bench. Allowing it here does not touch the board.
          </Alert>
        )}
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: dense ? 1 : 1.5 }}>
          <Chip size="small" variant="outlined" label={CLASS_LABEL[actionClass]} />
          {(revision !== undefined || revisionHash) && (
            <Chip
              size="small"
              variant="outlined"
              label={`Design ${revision !== undefined ? `r${revision}` : ""}${revisionHash ? ` · ${revisionHash.slice(0, 8)}` : ""}`.trim()}
            />
          )}
          {expiresAt && !decided && <Chip size="small" variant="outlined" color={expired ? "error" : "default"} label={expiryLabel(expiresAt, now)} />}
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            That didn't go through: {error}
          </Alert>
        )}
      </CardContent>
      {decided ? (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {"decision" in decided ? DECISION_LABEL[decided.decision] : decided.status === "expired" ? "This request expired" : "Already used"}
          </Typography>
        </Box>
      ) : expired ? (
        <Box sx={{ px: 2, pb: 2 }}>
          <Typography variant="body2">This request expired. Ask the agent again if you still want it.</Typography>
        </Box>
      ) : (
        <CardActions sx={{ px: 2, pb: dense ? 1.5 : 2, gap: 1, flexWrap: "wrap" }}>
          <Button variant="contained" color="primary" disabled={pending !== null} onClick={() => void decide("approve-once")}>
            {pending === "approve-once" ? "Allowing…" : "Allow once"}
          </Button>
          {!perActionOnly && (
            <Button variant="outlined" color="primary" disabled={pending !== null} onClick={() => void decide("approve-mission")}>
              {pending === "approve-mission"
                ? "Allowing…"
                : actionClass === "release"
                  ? "Always allow releasing designs in this mission"
                  : "Always allow design changes in this mission"}
            </Button>
          )}
          <Button variant="outlined" color="error" disabled={pending !== null} onClick={() => void decide("deny")}>
            {pending === "deny" ? "Saying no…" : "Deny"}
          </Button>
          {physical && (
            <Button component={RouterLink} to={`/m/${missionId}/bench`} sx={{ ml: "auto" }}>
              Open the bench
            </Button>
          )}
        </CardActions>
      )}
      {perActionOnly && !decided && !expired && !dense && (
        <Typography variant="caption" sx={{ display: "block", px: 2, pb: 1.5, color: "text.secondary" }}>
          {physical ? "Physical actions always need a person, every time." : "Adding a part always needs your OK, every time."}
        </Typography>
      )}
    </Card>
  );
}
