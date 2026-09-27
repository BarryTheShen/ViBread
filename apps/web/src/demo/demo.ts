/**
 * The public read-only demo (`VITE_DEMO=1`, hosted as static files under `VITE_BASE`, e.g. GitHub Pages at /ViBread/).
 * A service worker (public/demo-sw.js) answers every `/api/...` call from recorded files, so the app code is unchanged
 * apart from the few places that write data, sign in, or talk to hardware, which check `DEMO`.
 */
export const DEMO = import.meta.env.VITE_DEMO === "1";

/** Where visitors get the real app. */
export const GET_VIBREAD_URL = "https://github.com/BarryTheShen/ViBread/releases/latest";

/** Short explanations shown where a demo visitor would otherwise change data. */
export const DEMO_NOTES = {
  readOnly: "This is a read-only demo. Download ViBread to design and build your own.",
  chat: "This is a real recorded design session with Claude. The demo is read-only, so you can't send messages.",
  bench: "The bench needs a real Arduino and the ViBread desktop app. Try it shows the same sketch running in the browser.",
} as const;

/**
 * An in-app path as a full URL path under the site's base (`/m/x` → `/ViBread/m/x`), for plain links, `location`
 * changes and QR codes. React Router links and `navigate()` already add the basename themselves.
 */
export function appPath(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The router basename: "/" normally, "/ViBread" in the demo. */
export function routerBasename(): string {
  return import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";
}

let demoMissionId = "";

/** The example mission's id, read from the recorded manifest before the app renders. */
export function getDemoMissionId(): string {
  return demoMissionId;
}

export function setDemoMissionId(id: string): void {
  demoMissionId = id;
}
