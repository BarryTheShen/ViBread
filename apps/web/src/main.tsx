import "@fontsource-variable/inter";
import "@fontsource/lora/400.css";
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
import { createBrowserRouter, Outlet, useLocation } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RouteError } from "./components/RouteError.js";
import { SignInRequired, useProviders } from "./components/SignIn.js";
import { authClient } from "./api/auth.js";
import { HttpError } from "./api/client.js";
import { createMissionTheme } from "./theme.js";
import AppShell from "./shell/AppShell.js";

const NewMissionPage = lazy(() => import("./pages/NewMissionPage.js"));
const MissionPage = lazy(() => import("./pages/MissionPage.js"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js"));
const InventoryPage = lazy(() => import("./inventory/InventoryPage.js"));
const PhoneScanPage = lazy(() => import("./inventory/PhoneScanPage.js"));
const OAuthLoginPage = lazy(() => import("./pages/OAuthLoginPage.js"));
const OAuthConsentPage = lazy(() => import("./pages/OAuthConsentPage.js"));
const BenchPage = lazy(() => import("./bench/BenchPage.js"));
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
 * Bench and Build Mode fetch on their own and show raw errors on a 401; on a multi-user server with nobody signed in,
 * put the sign-in prompt above them (the workspace, Home and Settings render their own).
 */
function SignedOutBanner() {
  const location = useLocation();
  const providers = useProviders();
  const session = authClient.useSession();
  const onDevicePage = /^\/m\/[^/]+\/bench$|^\/b\/[^/]+$/.test(location.pathname);
  if (!onDevicePage || !providers.data || providers.data.singleOperator || session.isPending || session.data?.user) return null;
  return (
    <Box sx={{ p: 2, pb: 0 }}>
      <SignInRequired />
    </Box>
  );
}

function Shell() {
  return (
    <Suspense fallback={<Loading />}>
      <SignedOutBanner />
      <Outlet />
    </Suspense>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <NewMissionPage /> },
          { path: "/m/:missionId", element: <MissionPage /> },
          { path: "/m/:missionId/bench", element: <BenchPage /> },
          { path: "/inventory", element: <InventoryPage /> },
          { path: "/settings", element: <SettingsPage /> },
        ],
      },
      { path: "/b", element: <BuildModePage /> },
      { path: "/b/:missionId", element: <BuildModePage /> },
      { path: "/scan/:scanId", element: <PhoneScanPage /> },
      { path: "/login", element: <OAuthLoginPage /> },
      { path: "/consent", element: <OAuthConsentPage /> },
      { path: "*", element: <RouteError notFound /> },
    ],
  },
]);

function App() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  const theme = useMemo(() => createMissionTheme(reducedMotion), [reducedMotion]);
  return (
    <ThemeProvider theme={theme} defaultMode="system">
      <InitColorSchemeScript attribute="data" defaultMode="system" />
      <CssBaseline enableColorScheme />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
