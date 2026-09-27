import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import type { Step } from "@vibread/core";
import { useState } from "react";

/**
 * A "Repeat ×N" step's copies as boxes the builder can really tick (the step text says "Tick them off"; the ones in
 * the picture are only drawn). Copy 1 is the template step's, so it isn't listed. Ticks are a memory aid on this
 * screen only: nothing is saved and Done is never held back by them. Mount with `key={step.n}` to start each step fresh.
 */
export function RepeatChecklist({ step }: { step: Step }) {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set());
  if (step.repeat?.role !== "repeat") return null;
  const copies = step.repeat.copies.filter((copy) => copy.index > 1);
  if (copies.length === 0) return null;
  const done = copies.filter((copy) => ticked.has(copy.index)).length;
  return (
    <Box component="section" aria-label="Copies to build" sx={{ mt: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
        Copies built · {done} of {copies.length}
      </Typography>
      {copies.map((copy) => (
        <FormControlLabel
          key={copy.index}
          sx={{ display: "flex", alignItems: "flex-start", mr: 0, mt: 0.5 }}
          control={
            <Checkbox
              checked={ticked.has(copy.index)}
              onChange={(event) =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(copy.index);
                  else next.delete(copy.index);
                  return next;
                })
              }
              sx={{ py: 0.5 }}
            />
          }
          label={
            <Typography sx={{ pt: 0.6, overflowWrap: "anywhere" }}>
              Copy {copy.index} → {copy.boardPins.join(", ")}: {copy.parts.join(" + ")}, column {copy.column}
            </Typography>
          }
        />
      ))}
    </Box>
  );
}
