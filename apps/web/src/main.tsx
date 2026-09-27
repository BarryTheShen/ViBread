import "@fontsource-variable/inter";
import "@fontsource/lora/400.css";
import "@fontsource/lora/500.css";
import "@fontsource/lora/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import CssBaseline from "@mui/material/CssBaseline";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RouteError } from "./components/RouteError.js";
import { ClientErrorBoundary, installBrowserErrorReporter } from "./components/ClientErrorReporter.js";
import { SignInRequired, useProviders } from "./components/SignIn.js";
import { authClient } from "./api/auth.js";
import { HttpError } from "./api/client.js";
import { createMissionTheme } from "./theme.js";
import AppShell from "./shell/AppShell.js";
import { BenchRedirect } from "./workspace/BenchRedirect.js";
import { installStaleChunkReload } from "./staleChunks.js";
import { DEMO, getDemoMissionId } from "./demo/demo.js";
import { DemoBanner } from "./demo/DemoBanner.js";
import { startDemo } from "./demo/bootstrap.js";

const NewMissionPage = lazy(() => import("./pages/NewMissionPage.js"));
const MissionPage = lazy(() => import("./pages/MissionPage.js"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js"));
const InventoryPage = lazy(() => import("./inventory/InventoryPage.js"));
const PhoneScanPage = lazy(() => import("./inventory/PhoneScanPage.js"));
const OAuthLoginPage = lazy(() => import("./pages/OAuthLoginPage.js"));
const OAuthConsentPage = lazy(() => import("./pages/OAuthConsentPage.js"));
const BuildModePage = lazy(() => import("./build/BuildModePage.js"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx answers are final (not found, bad request); retry only transient failures.
      retry: (count, error) => count < 2 && !(error instanceof HttpError && error.status >= 400 && error.status < 500),
      refetchOnWindowFocus: true,
    },
  },
});

function Loading() {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <CircularProgress aria-label="Loading" />
    </Box>
  );
}

/**
 * Build Mode fetches on its own and shows raw errors on a 401; on a multi-user server with nobody signed in, put the
 * sign-in prompt above it (the workspace with its bench panel, Home and Settings render their own).
 */
function SignedOutBanner() {
  const location = useLocation();
  const providers = useProviders();
  const session = authClient.useSession();
  const onDevicePage = /^\/b\/[^/]+$/.test(location.pathname);
  if (DEMO || !onDevicePage || !providers.data || providers.data.singleOperator || session.isPending || session.data?.user) return null;
  return (
    <Box sx={{ p: 2, pb: 0 }}>
      <SignInRequired />
    </Box>
  );
}

function Shell() {
  if (DEMO) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
        <DemoBanner />
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </Box>
      </Box>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <SignedOutBanner />
      <Outlet />
    </Suspense>
  );
}

/** The demo's one mission: Home, Settings and the sign-in pages all lead to it. */
function ToDemoMission() {
  return <Navigate to={`/m/${encodeURIComponent(getDemoMissionId())}`} replace />;
}

const workspaceRoutes: RouteObject[] = DEMO
  ? [
      { path: "/", element: <ToDemoMission /> },
      { path: "/m/:missionId", element: <MissionPage /> },
      { path: "/m/:missionId/bench", element: <BenchRedirect /> },
      { path: "/inventory", element: <InventoryPage /> },
      { path: "/settings", element: <ToDemoMission /> },
    ]
  : [
      { path: "/", element: <NewMissionPage /> },
      { path: "/m/:missionId", element: <MissionPage /> },
      { path: "/m/:missionId/bench", element: <BenchRedirect /> },
      { path: "/inventory", element: <InventoryPage /> },
      { path: "/settings", element: <SettingsPage /> },
    ];

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: workspaceRoutes,
      },
      { path: "/b", element: <BuildModePage /> },
      { path: "/b/:missionId", element: <BuildModePage /> },
      { path: "/scan/:scanId", element: DEMO ? <ToDemoMission /> : <PhoneScanPage /> },
      { path: "/login", element: DEMO ? <ToDemoMission /> : <OAuthLoginPage /> },
      { path: "/consent", element: DEMO ? <ToDemoMission /> : <OAuthConsentPage /> },
      { path: "*", element: <RouteError notFound /> },
    ],
  },
], { basename: import.meta.env.BASE_URL.replace(/\/+$/, "") || "/" });

function App() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const theme = useMemo(() => createMissionTheme(reducedMotion), [reducedMotion]);
  return (
    <ThemeProvider theme={theme} defaultMode="system">
      <InitColorSchemeScript attribute="data" defaultMode="system" />
      <CssBaseline enableColorScheme />
      <QueryClientProvider client={queryClient}>
        <ClientErrorBoundary>
          <RouterProvider router={router} />
        </ClientErrorBoundary>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function DemoUnavailable({ message }: { message: string }) {
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", p: 4, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24 }}>The ViBread demo couldn't start</h1>
      <p>{message}</p>
      <p>
        <a href="https://github.com/BarryTheShen/ViBread/releases/latest">Get ViBread</a> to run it on your own computer.
      </p>
    </Box>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("index.html is missing #root");
const root = createRoot(rootElement);
installBrowserErrorReporter();
installStaleChunkReload();
const renderApp = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
if (DEMO) {
  startDemo().then(renderApp, (error: unknown) => root.render(<DemoUnavailable message={error instanceof Error ? error.message : String(error)} />));
} else {
  renderApp();
}
