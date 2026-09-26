import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import { Component, type ErrorInfo, type ReactNode } from "react";

const REPORT_PATH = "/api/debug/client-errors";
const WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 20;

interface ErrorDetails {
  message: string;
  stack?: string;
  componentStack?: string;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

const recentReports = new Map<string, number>();
const sentAt: number[] = [];
let browserReporterInstalled = false;

function missionIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/m\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function pruneReports(now: number): void {
  for (const [key, timestamp] of recentReports) {
    if (now - timestamp >= WINDOW_MS) recentReports.delete(key);
  }
  while (sentAt.length > 0 && now - sentAt[0] >= WINDOW_MS) sentAt.shift();
}

function detailsFromUnknown(value: unknown): ErrorDetails {
  if (value instanceof Error) return { message: value.message || value.name, stack: value.stack };
  if (typeof value === "string") return { message: value };
  try {
    const serialized = JSON.stringify(value);
    return { message: serialized === undefined ? String(value) : serialized };
  } catch {
    return { message: String(value) };
  }
}

/** Fire-and-forget client diagnostic report with per-error dedupe and a 20/minute cap. */
export function reportClientError(details: ErrorDetails): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const now = Date.now();
  pruneReports(now);
  const message = details.message.trim() || "Unknown client error";
  const key = [message, details.stack ?? "", details.componentStack ?? "", window.location.href].join("\u001f");
  const previous = recentReports.get(key);
  if (previous !== undefined && now - previous < WINDOW_MS) return;
  if (sentAt.length >= MAX_REPORTS_PER_WINDOW) return;
  recentReports.set(key, now);
  sentAt.push(now);
  const payload = {
    message,
    stack: details.stack ?? "",
    url: window.location.href,
    userAgent: navigator.userAgent,
    missionId: missionIdFromLocation(),
    componentStack: details.componentStack ?? "",
  };
  void fetch(REPORT_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

/** Install global browser error hooks once, before React renders the application. */
export function installBrowserErrorReporter(): void {
  if (browserReporterInstalled || typeof window === "undefined") return;
  browserReporterInstalled = true;
  window.addEventListener(
    "error",
    (event) => {
      const details = detailsFromUnknown(event.error ?? event.message);
      reportClientError({ ...details, message: details.message || event.message });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(detailsFromUnknown(event.reason));
  });
}

/** Top-level React boundary: report render errors and leave the user a recoverable screen. */
export class ClientErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const details = detailsFromUnknown(error);
    reportClientError({ ...details, componentStack: info.componentStack ?? "" });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Typography variant="h1" sx={{ mb: 2 }}>Something went wrong</Typography>
        <Alert severity="error" sx={{ mb: 2 }}>
          ViBread could not render this screen. The error was recorded for diagnostics.
        </Alert>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button variant="contained" onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="outlined" onClick={() => window.location.assign("/settings")}>Open Settings</Button>
        </Box>
      </Container>
    );
  }
}
