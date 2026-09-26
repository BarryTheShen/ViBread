import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import SendIcon from "@mui/icons-material/Send";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { isRecord } from "../lib/guards.js";
import { INTER_FONT } from "../theme.js";

/** The `ask_user` tool input ({ question, choices? }); tolerant of partial or over-long input (it is shown, never validated). */
export function askUserOf(input: unknown): { question?: string; choices: string[] } {
  const record = isRecord(input) ? input : {};
  return {
    ...(typeof record.question === "string" && record.question.trim() ? { question: record.question } : {}),
    choices: Array.isArray(record.choices) ? record.choices.filter((c): c is string => typeof c === "string" && c.trim().length > 0) : [],
  };
}

/**
 * Claude's clarifying question (`ask_user`): the question, one button per choice, and a free-text answer. The run has
 * stopped; answering sends a normal chat message. `answerable` is false once the conversation has moved on.
 */
export function AskUserCard({ input, answerable, onAnswer }: { input: unknown; answerable: boolean; onAnswer(text: string): void }) {
  const { question, choices } = askUserOf(input);
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onAnswer(text.trim());
    setText("");
  };
  return (
    <Paper variant="outlined" data-ask-user="" sx={{ my: 1, p: 1.5, borderRadius: "12px", fontFamily: INTER_FONT }}>
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
        <HelpOutlineIcon color="primary" fontSize="small" />
        <Typography variant="body2" sx={{ color: "primary.main", fontWeight: 600 }}>
          Question for you
        </Typography>
      </Stack>
      <Typography variant="body1">{question ?? "Claude is writing a question…"}</Typography>
      {choices.length > 0 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: 1 }}>
          {choices.map((choice) => (
            <Button key={choice} variant="outlined" disabled={!answerable} onClick={() => onAnswer(choice)} sx={{ textAlign: "left" }}>
              {choice}
            </Button>
          ))}
        </Stack>
      )}
      {answerable && (
        <Stack
          component="form"
          direction="row"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          sx={{ mt: 1.25, gap: 1, alignItems: "center", border: 1, borderColor: "divider", borderRadius: "8px", pl: 1.5, pr: 0.5 }}
        >
          <InputBase
            fullWidth
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={choices.length > 0 ? "Or type your own answer…" : "Type your answer…"}
            slotProps={{ input: { "aria-label": "Your answer" } }}
          />
          <IconButton type="submit" aria-label="Send answer" disabled={!text.trim()} size="small">
            <SendIcon fontSize="small" />
          </IconButton>
        </Stack>
      )}
    </Paper>
  );
}
