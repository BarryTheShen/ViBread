import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import { isRouteErrorResponse, Link as RouterLink, useRouteError } from "react-router";
import { useEffect } from "react";
import { reportClientError } from "./ClientErrorReporter.js";

/** Router error boundary + 404 page. */
export function RouteError({ notFound = false }: { notFound?: boolean }) {
  const error = useRouteError();
  const message = notFound
    ? "There's no page at this address."
    : isRouteErrorResponse(error)
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  useEffect(() => {
    if (notFound) return;
    reportClientError({
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }, [error, message, notFound]);
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
