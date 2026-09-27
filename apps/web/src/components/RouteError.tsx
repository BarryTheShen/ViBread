import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import { isRouteErrorResponse, Link as RouterLink, useRouteError } from "react-router";
import { useEffect, useState } from "react";
import { reportClientError } from "./ClientErrorReporter.js";
import { isStaleChunkError, reloadForStaleChunk } from "../staleChunks.js";

/** A lazy page from the build before a redeploy: reload once, then ask the user to. */
function StaleChunk() {
  const [reloading] = useState(reloadForStaleChunk);
  if (reloading) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <CircularProgress aria-label="Loading the updated ViBread" />
      </Box>
    );
  }
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Typography variant="h1" sx={{ mb: 2 }}>
        ViBread was updated
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        A newer version is on the server. Reload to open this page with it.
      </Alert>
      <Button variant="contained" onClick={() => window.location.reload()} autoFocus>
        Reload
      </Button>
    </Container>
  );
}

/** Router error boundary + 404 page. */
export function RouteError({ notFound = false }: { notFound?: boolean }) {
  const error = useRouteError();
  const staleChunk = !notFound && isStaleChunkError(error);
  const message = notFound
    ? "There's no page at this address."
    : isRouteErrorResponse(error)
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  useEffect(() => {
    if (notFound || staleChunk) return;
    reportClientError({
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }, [error, message, notFound, staleChunk]);
  if (staleChunk) return <StaleChunk />;
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Typography variant="h1" sx={{ mb: 2 }}>
        {notFound ? "Lost in space" : "Houston, we have a problem"}
      </Typography>
      <Alert severity={notFound ? "info" : "error"} sx={{ mb: 2 }}>
        {message}
      </Alert>
      <Button component={RouterLink} to="/" variant="contained">
        Back to Mission Control
      </Button>
    </Container>
  );
}
