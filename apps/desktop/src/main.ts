import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from "electron";
import QRCode from "qrcode";
import { loginShellPath } from "./path-env.js";
import { desktopPaths, openLog, type DesktopPaths } from "./runtime.js";
import { installSerial, type SerialState } from "./serial.js";
import { ServerProcess, type ServerInfo } from "./server.js";
import { apiKeyStatus, getApiKey, setApiKey } from "./settings.js";
import { pendingSteps, runSetup, seedGolden, type SetupStep } from "./setup.js";
import { runSmoke, writeSmokeFailure, type SmokeTimings } from "./smoke.js";

const SMOKE = process.env.VIBREAD_SMOKE === "1";
// Smoke runs (CI) and tests point userData at a throwaway directory; must happen before 'ready'.
if (process.env.VIBREAD_USER_DATA) app.setPath("userData", process.env.VIBREAD_USER_DATA);
app.setName("ViBread");

const STATIC = join(__dirname, "..", "static");
const PRELOAD = join(__dirname, "preload.cjs");

let paths: DesktopPaths;
let server: ServerProcess;
let serial: SerialState;
let mainWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let quitting = false;
const timings: SmokeTimings = { launchedAt: Date.now() };

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? setupWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(boot).catch((error: Error) => fatal("ViBread could not start", error));
}

async function boot(): Promise<void> {
  paths = { ...desktopPaths(), userPath: await loginShellPath() };
  mkdirSync(paths.logs, { recursive: true });
  server = new ServerProcess(paths, getApiKey);
  server.on("failed", (message: string) => {
    if (!quitting) void dialog.showMessageBox({ type: "error", title: "ViBread server stopped", message, detail: `Log: ${join(paths.logs, "server.log")}` }).then(() => app.quit());
  });
  server.on("ready", (info: ServerInfo) => {
    // After an automatic restart the port can change; keep the window on the live server.
    if (mainWindow && new URL(mainWindow.webContents.getURL() || info.localUrl).origin !== info.localUrl) void mainWindow.loadURL(`${info.localUrl}/`);
  });
  const desktopLog = openLog(paths, "desktop.log");
  serial = installSerial(session.defaultSession, () => server.info?.localUrl, () => mainWindow, (line) => desktopLog.write(`${new Date().toISOString()} ${line}\n`));
  registerIpc();
  buildMenu();

  const pending = pendingSteps(paths);
  if (pending.length > 0) {
    const started = Date.now();
    await firstRun(pending);
    timings.firstRunMs = Date.now() - started;
  }
  const serverStarted = Date.now();
  const info = await server.start();
  timings.serverStartMs = Date.now() - serverStarted;
  await openMainWindow(info);
  setupWindow?.close();
  if (SMOKE) {
    const result = await runSmoke({ window: mainWindow!, info, paths, serial, timings, setupRan: pending });
    await shutdown(result.ok ? 0 : 1);
  }
}

/** Shows the setup window and runs pending steps; on failure waits for Retry. */
async function firstRun(pending: SetupStep[]): Promise<void> {
  setupWindow = smallWindow("setup.html", 560, 440, "Setting up ViBread");
  setupWindow.on("closed", () => {
    setupWindow = undefined;
    if (!mainWindow && !quitting) app.quit();
  });
  await once(setupWindow.webContents, "did-finish-load");
  const send = (channel: string, payload: unknown) => setupWindow?.webContents.send(channel, payload);
  for (const step of ["toolchain", "seed"] as SetupStep[]) if (!pending.includes(step)) send("setup:progress", { step, state: "skipped" });
  for (;;) {
    let current: SetupStep = pendingSteps(paths)[0] ?? "toolchain";
    try {
      const steps = pendingSteps(paths);
      const ran = await runSetup(paths, steps, (progress) => {
        current = progress.step;
        send("setup:progress", progress);
      });
      Object.assign(timings, { toolchainMs: ran.toolchain, seedMs: ran.seed });
      for (const step of steps) send("setup:progress", { step, state: "done" });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (SMOKE) throw error;
      send("setup:error", { step: current, message, logPath: join(paths.logs, "setup.log") });
      const { promise, resolve } = Promise.withResolvers<void>();
      ipcMain.handleOnce("setup:retry", () => resolve());
      await promise;
    }
  }
}

async function openMainWindow(info: ServerInfo): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "ViBread",
    backgroundColor: "#0b1118",
    icon: join(STATIC, "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow = window;
  window.on("closed", () => {
    mainWindow = undefined;
  });
  const appOrigin = () => server.info?.localUrl;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === appOrigin()) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin()) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  await window.loadURL(`${info.localUrl}/`);
  window.show();
}

function smallWindow(page: string, width: number, height: number, title: string): BrowserWindow {
  const window = new BrowserWindow({
    width,
    height,
    title,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#0b1118",
    icon: join(STATIC, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
  });
  window.setMenuBarVisibility(false);
  void window.loadFile(join(STATIC, page));
  return window;
}

function registerIpc(): void {
  ipcMain.handle("setup:open-logs", () => shell.openPath(paths.logs));
  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("apikey:status", () => apiKeyStatus());
  ipcMain.handle("apikey:save", async (_event, key: unknown) => {
    if (typeof key !== "string" || !key.trim()) throw new Error("Enter a key.");
    setApiKey(key.trim());
    await server.restart();
    mainWindow?.reload();
  });
  ipcMain.handle("apikey:clear", async () => {
    setApiKey(undefined);
    await server.restart();
    mainWindow?.reload();
  });
  ipcMain.handle("phone:info", async () => {
    const info = server.info;
    if (!info) throw new Error("server is not running");
    // Asked over loopback, the server includes the LAN pairing token: unpaired devices on the Wi-Fi get a 403.
    const connections = (await (await fetch(`${info.localUrl}/api/connections`)).json()) as { phoneUrl?: string; phonePairQuery?: string };
    const origin = (connections.phoneUrl ?? info.publicUrl).replace(/\/$/, "");
    // Paired phones only get Build Mode; the server redirects /b?pair=… to the phone mission chooser.
    const url = `${origin}/b${connections.phonePairQuery ? `?${connections.phonePairQuery}` : ""}`;
    return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 440 }), lan: !/^http:\/\/(localhost|127\.)/.test(origin) };
  });
}

let openSmall: BrowserWindow | undefined;
function showSmall(page: string, width: number, height: number, title: string): void {
  if (openSmall && !openSmall.isDestroyed()) openSmall.close();
  openSmall = smallWindow(page, width, height, title);
  if (mainWindow) openSmall.setParentWindow(mainWindow);
}

async function resetExamples(): Promise<void> {
  const { response } = await dialog.showMessageBox(mainWindow!, {
    type: "question",
    buttons: ["Add fresh examples", "Cancel"],
    cancelId: 1,
    message: "Add fresh copies of the example missions?",
    detail: "The ViBread server restarts while they are built (about a minute). Your own missions and the current examples are kept.",
  });
  if (response !== 0) return;
  await server.stop();
  const log = openLog(paths, "setup.log");
  const progressWindow = smallWindow("setup.html", 560, 440, "Rebuilding example missions");
  progressWindow.setParentWindow(mainWindow ?? null);
  try {
    await once(progressWindow.webContents, "did-finish-load");
    const send = (payload: unknown) => progressWindow.isDestroyed() || progressWindow.webContents.send("setup:progress", payload);
    send({ step: "toolchain", state: "skipped" });
    await seedGolden(paths, (line) => log.write(`${line}\n`), send);
    send({ step: "seed", state: "done" });
  } catch (error) {
    await dialog.showMessageBox(mainWindow!, { type: "error", message: "Could not rebuild the example missions", detail: `${error instanceof Error ? error.message : String(error)}\n\nLog: ${join(paths.logs, "setup.log")}` });
  } finally {
    log.end();
    if (!progressWindow.isDestroyed()) progressWindow.close();
    const info = await server.start();
    await mainWindow?.loadURL(`${info.localUrl}/`);
  }
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const vibread: MenuItemConstructorOptions[] = [
    { label: "Set Anthropic API key…", click: () => showSmall("apikey.html", 520, 330, "Anthropic API key") },
    { label: "Show phone link / QR", click: () => showSmall("phone.html", 660, 440, "Open ViBread on your phone") },
    { type: "separator" },
    { label: "Open data folder", click: () => void shell.openPath(paths.userData) },
    { label: "Open logs", click: () => void shell.openPath(paths.logs) },
    { label: "Reset example missions", click: () => void resetExamples() },
  ];
  const view: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  const template: MenuItemConstructorOptions[] = [
    mac
      ? { label: "ViBread", submenu: [{ role: "about" }, { type: "separator" }, ...vibread, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }
      : { label: "ViBread", submenu: [...vibread, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: view },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "ViBread on GitHub", click: () => void shell.openExternal("https://github.com/BarryTheShen/ViBread") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shutdown(code: number): Promise<void> {
  quitting = true;
  await server?.stop().catch(() => {});
  app.exit(code);
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdown(0);
});
app.on("window-all-closed", () => {
  if (!setupWindow) void shutdown(0);
});

function fatal(title: string, error: Error): void {
  const logs = paths ? join(paths.logs, "server.log") : "";
  console.error(error);
  if (SMOKE) {
    void writeSmokeFailure(paths, error, timings).finally(() => shutdown(1));
    return;
  }
  dialog.showErrorBox(title, `${error.message}\n\n${logs ? `Log: ${logs}` : ""}`);
  void shutdown(1);
}
