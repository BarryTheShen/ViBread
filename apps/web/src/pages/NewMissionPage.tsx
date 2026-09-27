import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useConnections, useCreateMission } from "../api/hooks.js";
import { useInventory } from "../api/inventory.js";
import { Composer } from "../chat/Composer.js";
import { CHAT_MAX_WIDTH } from "../chat/MissionChat.js";
import { ErrorOrSignIn } from "../components/SignIn.js";
import { PartsChip } from "../inventory/PartsChip.js";
import { LORA_FONT } from "../theme.js";

const DRAFT_BRIEF = "vibread.draft.brief";

/** Suggestion chips under the chat box: a short name and the brief it fills in. */
const SUGGESTIONS: Array<{ label: string; brief: string }> = [
  { label: "Night light", brief: "A night light that turns on by itself when the room gets dark, with a knob to set how bright it gets." },
  { label: "Traffic light", brief: "A traffic light with red, yellow and green LEDs that cycles like a real one, and a button for pedestrians." },
  { label: "Reaction game", brief: "A reaction game: an LED lights up after a random wait and I press the button as fast as I can; a buzzer beeps if I'm too early." },
  { label: "Doorbell", brief: "A doorbell: pressing the button plays a short tune on a buzzer and blinks an LED." },
];

function greeting(hour: number): string {
  if (hour < 5) return "Up late?";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

/** New mission (plan §3.1): greeting, the centered chat box, suggestions. Sending creates the mission and opens its chat. */
export default function NewMissionPage() {
  const navigate = useNavigate();
  const create = useCreateMission();
  const inventory = useInventory();
  const connections = useConnections();
  const claudeMissing = connections.data?.claude.using === "none";
  // The draft survives a sign-in round trip (Sign in → provider → back here): kept in this tab's sessionStorage.
  const [brief, setBrief] = useState(() => sessionStorage.getItem(DRAFT_BRIEF) ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => sessionStorage.setItem(DRAFT_BRIEF, brief), [brief]);

  const partsCount = inventory.data?.entries.reduce((total, entry) => total + entry.quantity, 0);
  const inventoryEmpty = inventory.isSuccess && partsCount === 0;

  const start = (text: string) => {
    // No `inventory`: the server copies the owner's ready inventory into the mission. The brief becomes the first chat
    // message on the mission page (MissionChat's BriefKickoff sends it once the empty history has loaded).
    create.mutate(
      { brief: text },
      {
        onSuccess: (m) => {
          sessionStorage.removeItem(DRAFT_BRIEF);
          setBrief("");
          navigate(`/m/${m.id}`);
        },
      },
    );
  };

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <Box component="main" sx={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", px: 3, py: 6 }}>
        <Box sx={{ width: "100%", maxWidth: CHAT_MAX_WIDTH, mx: "auto" }}>
          <Typography variant="h1" component="h1" sx={{ textAlign: "center", mb: 3, fontFamily: LORA_FONT, fontWeight: 500, letterSpacing: "-0.01em", fontSize: { xs: "1.75rem", md: "2.25rem" } }}>
            {greeting(new Date().getHours())} What are we building?
          </Typography>
          <Composer
            placeholder="A lamp that fills like the moon when I press a button…"
            label="Describe what you want to build"
            running={false}
            disabled={create.isPending}
            onSend={start}
            onStop={() => undefined}
            value={brief}
            onValueChange={setBrief}
            minRows={3}
            autoFocus
            inputRef={inputRef}
            partsChip={inventory.isSuccess ? <PartsChip count={partsCount} onClick={() => navigate("/inventory")} /> : null}
          />
          {create.isError && (
            // Signed out on a multi-user server: offer sign-in; the typed brief stays in the box.
            <ErrorOrSignIn error={create.error} message="Sign in to start this mission. What you typed stays here.">
              <Alert severity="error" sx={{ mt: 1.5 }}>
                Couldn't start the mission: {create.error.message}
              </Alert>
            </ErrorOrSignIn>
          )}
          {claudeMissing && (
            // Said before sending: otherwise the first thing a new maker sees is a mission whose only reply is an error.
            <Alert
              severity="info"
              sx={{ mt: 1.5 }}
              action={
                <Button component={RouterLink} to="/settings" color="inherit" size="small">
                  Connect
                </Button>
              }
            >
              Claude isn't connected yet, so it can't design a new mission. Connect it in Settings, or open a ready-made mission in the sidebar to try the checks, simulator and build steps.
            </Alert>
          )}
          <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", justifyContent: "center", mt: 2 }} aria-label="Ideas to start from">
            {SUGGESTIONS.map((s) => (
              <Chip
                key={s.label}
                label={s.label}
                variant="outlined"
                clickable
                onClick={() => {
                  setBrief(s.brief);
                  inputRef.current?.focus();
                }}
              />
            ))}
          </Stack>
          {inventoryEmpty && (
            <Typography variant="body2" sx={{ textAlign: "center", mt: 2, color: "text.secondary" }}>
              Inventory empty?{" "}
              <Button component={RouterLink} to="/inventory" size="small">
                Scan your parts
              </Button>
            </Typography>
          )}
          <Typography variant="caption" component="p" sx={{ textAlign: "center", mt: 3, color: "text.secondary" }}>
            Claude designs from your parts, checks everything in a simulator, then shows you how to build it step by step.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
