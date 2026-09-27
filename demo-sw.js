/*
 * ViBread public demo: answers the app's `/api/...` calls from the recorded files in demo-data/, so the static site
 * behaves like a read-only server. Registered only by the demo build, with scope = the site's base path.
 */
const BASE = new URL("./", self.location.href).pathname;
const DATA = `${BASE}demo-data/`;

const READ_ONLY = { code: "DEMO_READ_ONLY", message: "This is a read-only demo. Download ViBread to design and build your own." };
const NOT_IN_DEMO = { code: "NOT_IN_DEMO", message: "This isn't part of the demo." };

let manifestPromise;

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(`${DATA}manifest.json`, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`demo manifest ${response.status}`);
        return response.json();
      })
      .then((manifest) => {
        const byPath = new Map();
        for (const [key, entry] of Object.entries(manifest.entries ?? {})) {
          const pathname = key.split("?")[0];
          if (!byPath.has(pathname)) byPath.set(pathname, entry);
        }
        return { exact: manifest.entries ?? {}, byPath };
      })
      .catch((error) => {
        manifestPromise = undefined;
        throw error;
      });
  }
  return manifestPromise;
}

function json(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

async function answerApi(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(403, READ_ONLY);
  if (/^\/api\/missions\/[^/]+\/chat\/stream$/.test(url.pathname)) return new Response(null, { status: 204 });
  let manifest;
  try {
    manifest = await loadManifest();
  } catch {
    return json(503, { code: "DEMO_DATA_MISSING", message: "The demo data couldn't be loaded. Reload the page to try again." });
  }
  const entry = manifest.exact[url.pathname + url.search] ?? manifest.byPath.get(url.pathname);
  if (!entry) return json(404, NOT_IN_DEMO);
  const file = await fetch(`${DATA}${entry.file}`);
  if (!file.ok) return json(404, NOT_IN_DEMO);
  const headers = new Headers({ "Content-Type": entry.type || file.headers.get("Content-Type") || "application/octet-stream" });
  return new Response(request.method === "HEAD" ? null : file.body, { status: entry.status || 200, headers });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data === "claim") event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    event.respondWith(answerApi(event.request, url));
    return;
  }
  if (url.pathname === "/version.json" && BASE !== "/") {
    event.respondWith(fetch(`${BASE}version.json`, { cache: "no-cache" }));
  }
});
