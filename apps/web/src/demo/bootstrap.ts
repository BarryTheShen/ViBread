import { setDemoMissionId } from "./demo.js";

interface DemoManifest {
  version: number;
  missionId: string;
}

/**
 * Before the demo renders: install demo-sw.js (which answers `/api/...` from the recorded files), wait until it
 * controls this page, and read which mission the recording holds. Throws a visitor-readable message on failure.
 */
export async function startDemo(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  if (!("serviceWorker" in navigator)) {
    throw new Error("This demo needs a browser with service workers (a current Chrome, Edge, Firefox or Safari, outside private browsing).");
  }
  const container = navigator.serviceWorker;
  if (!container.controller) {
    const controlled = new Promise<void>((resolve) => container.addEventListener("controllerchange", () => resolve(), { once: true }));
    await container.register(`${base}demo-sw.js`, { scope: base });
    const registration = await container.ready;
    // A hard reload leaves the page uncontrolled even though the worker is already active: ask it to claim us.
    registration.active?.postMessage("claim");
    await controlled;
  } else {
    // Pick up a newer demo-sw.js on the next visit; the current one keeps serving this page.
    void container.register(`${base}demo-sw.js`, { scope: base }).catch(() => undefined);
  }
  const response = await fetch(`${base}demo-data/manifest.json`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`The demo data couldn't be loaded (${response.status}). Reload the page to try again.`);
  const manifest = (await response.json()) as DemoManifest;
  setDemoMissionId(manifest.missionId);
}
