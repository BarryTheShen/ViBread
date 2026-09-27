import Box from "@mui/material/Box";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Sidebar, useSidebarCollapsed } from "./Sidebar.js";

/** The desktop shell: a persistent mission navigator and a non-scrolling viewport for each page's own layout. */
export default function AppShell() {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  // Phones (MissionPage's breakpoint) start with the rail: the full sidebar left a ~90px-wide page that overflowed.
  // Opening it there is for this visit only, so the laptop's saved choice stays as it was.
  const phone = useMediaQuery("(max-width: 699.95px)", { noSsr: true });
  const [phoneOpen, setPhoneOpen] = useState(false);
  // Picking a mission (or any page) from the opened sidebar hands the narrow screen back to that page.
  const { pathname } = useLocation();
  useEffect(() => setPhoneOpen(false), [pathname]);
  const railOnly = phone ? !phoneOpen : collapsed;
  return (
    <Box sx={{ display: "flex", width: "100%", height: "100dvh", minHeight: 0, overflow: "hidden", bgcolor: "background.default" }}>
      <Sidebar collapsed={railOnly} onToggle={() => (phone ? setPhoneOpen(!phoneOpen) : setCollapsed(!collapsed))} />
      <Box component="main" sx={{ flex: 1, minWidth: 0, minHeight: 0, height: "100%", overflow: "auto", display: "flex", flexDirection: "column" }}>
        <Outlet />
      </Box>
    </Box>
  );
}
