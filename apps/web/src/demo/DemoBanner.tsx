import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import type { ReactNode } from "react";
import { GET_VIBREAD_URL } from "./demo.js";

/** The slim strip across the top of every demo page. */
export function DemoBanner() {
  return (
    <Box
      role="note"
      sx={{ flex: "none", px: 2, py: 0.5, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", columnGap: 1.5, bgcolor: "primary.main", color: "primary.contrastText" }}
    >
      <Typography variant="body2" sx={{ fontWeight: 500, textAlign: "center" }}>
        Demo · one example project, read-only · no Arduino or sign-in needed
      </Typography>
      <Link href={GET_VIBREAD_URL} target="_blank" rel="noopener" color="inherit" underline="always" variant="body2" sx={{ fontWeight: 700 }}>
        Get ViBread
      </Link>
    </Box>
  );
}

/** A short read-only explanation in place of a control that would change data. */
export function DemoNote({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Alert severity="info" variant="outlined" sx={sx}>
      {children}{" "}
      <Link href={GET_VIBREAD_URL} target="_blank" rel="noopener">
        Get ViBread
      </Link>
    </Alert>
  );
}
