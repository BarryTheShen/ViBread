import { Navigate, useLocation, useParams } from "react-router";
import { benchPanelPath } from "./panelUrl.js";

/** The old bench page (`/m/:id/bench?tests=&returnTo=`) now lives in the mission panel: go there, keeping the scope. */
export function BenchRedirect() {
  const { missionId = "" } = useParams<{ missionId: string }>();
  const { search } = useLocation();
  return <Navigate replace to={benchPanelPath(missionId, search)} />;
}
