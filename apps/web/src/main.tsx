import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RouteError } from "./components/RouteError.js";
import { HttpError } from "./api/client.js";
import { createMissionTheme } from "./theme.js";

const HomePage = lazy(() => import("./pages/HomePage.js"));
const MissionPage = lazy(() => import("./pages/MissionPage.js"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js"));
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

function Shell() {
  return (
    <Suspense fallback={<Loading />}>
      <Outlet />
    </Suspense>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/m/:missionId", element: <MissionPage /> },
      { path: "/m/:missionId/bench", element: <BenchPage /> },
      { path: "/b/:missionId", element: <BuildModePage /> },
      { path: "/settings", element: <SettingsPage /> },
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
    <ThemeProvider theme={theme}>
      <CssBaseline />
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
