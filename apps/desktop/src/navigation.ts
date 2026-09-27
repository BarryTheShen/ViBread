/** The slice of BrowserWindow that loadServerPage needs (a fake in tests). */
export interface LoadableWindow {
  loadURL(url: string): Promise<void>;
  webContents: { getURL(): string };
}

// Chromium's net::ERR_ABORTED: another navigation (Ctrl+R, a restart's reload) replaced this one before it finished.
const ERR_ABORTED = -3;

/**
 * Loads the server's page into the window. A reload or other navigation during the load aborts it: that is fine when the
 * window ended up on the server anyway, and otherwise (the reload re-ran the local "Starting…" page) the load is retried
 * once. Any other failure is thrown.
 */
export async function loadServerPage(window: LoadableWindow, url: string): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    if ((error as { errno?: unknown }).errno !== ERR_ABORTED) throw error;
    if (sameOrigin(window.webContents.getURL(), url)) return;
    await window.loadURL(url);
  }
}

function sameOrigin(current: string, url: string): boolean {
  try {
    return new URL(current).origin === new URL(url).origin;
  } catch {
    return false;
  }
}
