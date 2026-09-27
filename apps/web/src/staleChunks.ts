/**
 * A redeploy renames Vite's hashed chunks, so a tab opened before it fails the next lazy import. Reload once (same URL)
 * to pick up the new index.html; a sessionStorage timestamp keeps a genuinely broken deploy from looping.
 */

const RELOAD_KEY = "vibread:stale-chunk-reload";
/** A second failure this soon after the automatic reload means reloading didn't help. */
export const STALE_CHUNK_GUARD_MS = 60_000;

/** Browser wordings for a lazy chunk or its preloaded CSS that is no longer on the server. */
const STALE_CHUNK_MESSAGE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

let reloadPending = false;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_CHUNK_MESSAGE.test(message);
}

/** Whether an automatic reload is allowed, given the stored timestamp of the last one. */
export function mayAutoReload(lastReload: string | null, now: number): boolean {
  const last = Number(lastReload);
  return !lastReload || !Number.isFinite(last) || now - last < 0 || now - last >= STALE_CHUNK_GUARD_MS;
}

/**
 * Reload the page for a stale chunk unless one automatic reload already happened recently. Returns true while a
 * reload is under way (show a quiet "updating" state), false when the caller should offer a manual Reload instead.
 */
export function reloadForStaleChunk(): boolean {
  if (reloadPending) return true;
  try {
    if (!mayAutoReload(window.sessionStorage.getItem(RELOAD_KEY), Date.now())) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No sessionStorage (privacy mode): without the guard a reload could loop, so leave it to the user.
    return false;
  }
  reloadPending = true;
  window.location.reload();
  return true;
}

/** Vite fires this when a lazy chunk or its CSS fails to load; the route error screen covers the rendered case. */
export function installStaleChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (isStaleChunkError(event.payload)) reloadForStaleChunk();
  });
}
