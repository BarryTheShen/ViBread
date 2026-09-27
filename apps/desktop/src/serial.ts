import { dialog, type BrowserWindow, type MessageBoxOptions, type SerialPort, type Session, type WebContents } from "electron";
import { BOARD_PROFILES } from "@vibread/core";

// Every USB id ViBread's bench knows (Uno/Nano genuine + CH340/FTDI/CP2102 clones), keyed "vid:pid" in decimal
// because Electron reports SerialPort.vendorId/productId as decimal strings.
const KNOWN_USB = new Map<string, string>();
for (const profile of Object.values(BOARD_PROFILES)) {
  for (const usb of profile.usb) if (!KNOWN_USB.has(`${usb.vid}:${usb.pid}`)) KNOWN_USB.set(`${usb.vid}:${usb.pid}`, usb.label);
}

type PortInfo = Pick<SerialPort, "portId" | "portName" | "displayName" | "vendorId" | "productId">;

const usbLabel = (port: PortInfo) => KNOWN_USB.get(`${Number(port.vendorId)}:${Number(port.productId)}`);

/** Whether the port's USB id is one of the boards (or USB bridges) the bench supports. */
export function isKnownBoard(port: PortInfo): boolean {
  return usbLabel(port) !== undefined;
}

/**
 * The name people see in Device Manager: "USB-SERIAL CH340 (COM3)". Chromium strips the "(COMn)" suffix from the
 * Windows friendly name, so the port name goes back on; without an OS name ViBread's own USB label stands in.
 */
export function portLabel(port: PortInfo): string {
  const name = port.displayName?.trim() || usbLabel(port);
  if (!name) return port.portName;
  return name.includes(port.portName) ? name : `${name} (${port.portName})`;
}

/** How the chooser answers a request: pick one port now, ask the person, or wait for a board to be plugged in. */
export type ChooserPlan = { kind: "pick"; port: PortInfo } | { kind: "ask"; choices: PortInfo[] } | { kind: "wait" };

/** Exactly one known board is picked automatically; several ports need a choice; none waits for a plug-in. */
export function planChooser(ports: readonly PortInfo[]): ChooserPlan {
  const known = ports.filter(isKnownBoard);
  if (known.length === 1) return { kind: "pick", port: known[0] };
  const choices = known.length > 0 ? known : [...ports];
  return choices.length > 0 ? { kind: "ask", choices } : { kind: "wait" };
}

export interface SerialState {
  handlerInstalled: boolean;
  lastChooser?: { ports: number; picked: string };
}

/** Origin of a permission request, or undefined when Electron hands over something that is not a URL ("", "null"). */
function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Web Serial for the app origin only: navigator.serial.requestPort() → 'select-serial-port'. Exactly one known Arduino
 * port is picked automatically; several ports get a native chooser. With no port yet (the board is still being
 * plugged in, or its CH340 re-enumerates after a reset) a "Plug in your Arduino" box waits and picks the board as soon
 * as it appears; Cancel rejects requestPort (NotFoundError). A port unplugged while the chooser is open is never
 * handed back.
 */
export function installSerial(
  session: Session,
  appOrigin: () => string | undefined,
  parent: () => BrowserWindow | undefined,
  log: (line: string) => void,
): SerialState {
  const state: SerialState = { handlerInstalled: true };
  const trusted = (origin: string | undefined) => {
    const expected = appOrigin();
    return expected !== undefined && originOf(origin) === expected;
  };
  // Ports Chromium currently offers to each open requestPort() chooser (one per webContents), kept live by
  // 'serial-port-added' / 'serial-port-removed', which Electron only fires while a chooser is pending.
  const live = new WeakMap<WebContents, { ports: PortInfo[]; added: (port: PortInfo) => void }>();
  session.on("serial-port-added", (_event, port, webContents) => {
    const request = live.get(webContents);
    if (!request) return;
    request.ports = [...request.ports.filter((known) => known.portId !== port.portId), port];
    request.added(port);
  });
  session.on("serial-port-removed", (_event, port, webContents) => {
    const request = live.get(webContents);
    if (request) request.ports = request.ports.filter((known) => known.portId !== port.portId);
  });

  const showBox = (options: MessageBoxOptions) => {
    const window = parent();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  session.on("select-serial-port", (event, portList, webContents, callback) => {
    event.preventDefault();
    const request = { ports: [...portList] as PortInfo[], added: (_port: PortInfo) => {} };
    live.set(webContents, request);
    let settled = false;
    const finish = (port: PortInfo | undefined, picked: string) => {
      if (settled) return;
      settled = true;
      live.delete(webContents);
      state.lastChooser = { ports: request.ports.length, picked };
      log(`select-serial-port: ${request.ports.length} port(s) [${request.ports.map((p) => `${p.portName} ${p.vendorId ?? "?"}:${p.productId ?? "?"}`).join(", ")}] → ${picked}`);
      callback(port?.portId ?? "");
    };

    const ask = (choices: PortInfo[]) => {
      void showBox({
        type: "question",
        title: "Choose your Arduino",
        message: "Which serial port is your Arduino connected to?",
        detail: "Pick the Uno/Nano (or its CH340 / FTDI / CP2102 USB bridge). Never pick a keyboard, mouse or phone.",
        buttons: [...choices.map(portLabel), "Cancel"],
        cancelId: choices.length,
        noLink: true,
      }).then(({ response }) => {
        const port = choices[response];
        if (!port) return finish(undefined, "cancelled");
        // Unplugged (or re-enumerated under a new id) while the box was open: never hand Chromium a stale port.
        if (!request.ports.some((known) => known.portId === port.portId)) return finish(undefined, `${portLabel(port)} disappeared before it was chosen`);
        finish(port, portLabel(port));
      });
    };

    const plan = planChooser(request.ports);
    if (plan.kind === "pick") return finish(plan.port, portLabel(plan.port));
    if (plan.kind === "ask") return ask(plan.choices);

    const closeBox = new AbortController();
    request.added = (port) => {
      if (!isKnownBoard(port)) return;
      closeBox.abort();
      finish(port, `${portLabel(port)} (plugged in while waiting)`);
    };
    void showBox({
      type: "info",
      title: "Plug in your Arduino",
      message: "No Arduino found yet",
      detail: "Plug the Uno/Nano into a USB port. ViBread connects as soon as it shows up; with a charge-only cable it never will.",
      buttons: ["Cancel"],
      cancelId: 0,
      noLink: true,
      signal: closeBox.signal,
    }).then(() => finish(undefined, "cancelled (no matching ports)"));
  });

  // Keep the existing own-origin permissions (including serial), but never grant audio: parts scans only need video.
  const allow = (permission: string, origin: string | undefined, mediaType?: string, mediaTypes?: readonly string[]) => {
    if (!trusted(origin)) return false;
    if (permission !== "media") return true;
    if (mediaType !== undefined) return mediaType === "video";
    return mediaTypes?.length === 1 && mediaTypes[0] === "video";
  };
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => allow(permission, requestingOrigin, details.mediaType));
  session.setDevicePermissionHandler((details) => details.deviceType === "serial" && trusted(details.origin));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = ("securityOrigin" in details ? details.securityOrigin : undefined) ?? ("requestingUrl" in details ? details.requestingUrl : webContents.getURL());
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(allow(permission, origin, undefined, mediaTypes));
  });
  return state;
}
