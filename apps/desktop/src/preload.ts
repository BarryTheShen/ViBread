// Preload for ViBread's own small windows (setup, API key, phone link). The main window runs the web app without any
// preload: it needs nothing beyond standard web APIs (Web Serial included).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const INVOKE = ["setup:retry", "setup:open-logs", "apikey:status", "apikey:save", "apikey:clear", "phone:info", "window:close", "shell:open"];
const EVENTS = ["setup:progress", "setup:error"];

contextBridge.exposeInMainWorld("vibread", {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error(`channel ${channel} is not allowed`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: string, listener: (payload: unknown) => void): void {
    if (!EVENTS.includes(channel)) throw new Error(`channel ${channel} is not allowed`);
    ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => listener(payload));
  },
});
