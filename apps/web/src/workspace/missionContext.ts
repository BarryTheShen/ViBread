import type { MissionDetail } from "@vibread/core";
import { createContext, useContext } from "react";

export interface MissionContextValue {
  missionId: string;
  detail?: MissionDetail;
}

export const MissionContext = createContext<MissionContextValue | null>(null);

export function useMissionContext(): MissionContextValue {
  const value = useContext(MissionContext);
  if (!value) throw new Error("useMissionContext must be used inside the mission workspace");
  return value;
}
