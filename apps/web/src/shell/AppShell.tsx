import Box from "@mui/material/Box";
import { Outlet } from "react-router";
import { Sidebar, useSidebarCollapsed } from "./Sidebar.js";

/** The desktop shell: a persistent mission navigator and a non-scrolling viewport for each page's own layout. */
export default function AppShell() {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  return (
    <Box sx={{ display: "flex", width: "100%", height: "100dvh", minHeight: 0, overflow: "hidden", bgcolor: "background.default" }}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <Box component="main" sx={{ flex: 1, minWidth: 0, minHeight: 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <Outlet />
      </Box>
    </Box>
  );
}
