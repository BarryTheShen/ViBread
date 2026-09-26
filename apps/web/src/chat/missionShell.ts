import { createContext, useContext } from "react";
import type { MissionShellValue } from "../contracts.js";

/** Mission-level UI state (contracts.ts MissionShellValue), created by pages/MissionPage.tsx for the chat and the panel. */
export const MissionShellContext = createContext<MissionShellValue | null>(null);

export function useMissionShell(): MissionShellValue {
  const value = useContext(MissionShellContext);
  if (!value) throw new Error("useMissionShell must be used inside a mission page");
  return value;
}
