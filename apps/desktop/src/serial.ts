import { dialog, type BrowserWindow, type Session } from "electron";
import { BOARD_PROFILES } from "@vibread/core";

// Every USB id ViBread's bench knows (Uno/Nano genuine + CH340/FTDI/CP2102 clones), keyed "vid:pid" in decimal
// because Electron reports SerialPort.vendorId/productId as decimal strings.
const KNOWN_USB = new Map<string, string>();
for (const profile of Object.values(BOARD_PROFILES)) {
  for (const usb of profile.usb) if (!KNOWN_USB.has(`${usb.vid}:${usb.pid}`)) KNOWN_USB.set(`${usb.vid}:${usb.pid}`, usb.label);
}

export interface SerialState {
  handlerInstalled: boolean;
  lastChooser?: { ports: number; picked: string };
}

/**
 * Web Serial for the app origin only: navigator.serial.requestPort() → 'select-serial-port'. Exactly one known Arduino
 * port is picked automatically; several ports get a native chooser; none cancels (requestPort rejects NotFoundError).
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
    return expected !== undefined && origin !== undefined && new URL(origin).origin === expected;
  };

  session.on("select-serial-port", (event, portList, _webContents, callback) => {
    event.preventDefault();
    const known = portList.filter((port) => KNOWN_USB.has(`${Number(port.vendorId)}:${Number(port.productId)}`));
    const describe = (port: (typeof portList)[number]) => {
      const label = KNOWN_USB.get(`${Number(port.vendorId)}:${Number(port.productId)}`);
      return [port.displayName || port.portName, label && label !== port.displayName ? label : undefined, port.portName]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join(" — ");
    };
    const finish = (portId: string, picked: string) => {
      state.lastChooser = { ports: portList.length, picked };
      log(`select-serial-port: ${portList.length} port(s) [${portList.map((p) => `${p.portName} ${p.vendorId ?? "?"}:${p.productId ?? "?"}`).join(", ")}] → ${picked}`);
      callback(portId);
    };
    if (portList.length === 0) return finish("", "none (no matching ports)");
    if (known.length === 1) return finish(known[0].portId, describe(known[0]));
    const choices = known.length > 0 ? known : portList;
    const window = parent();
    const options = {
      type: "question" as const,
      title: "Choose your Arduino",
      message: "Which serial port is your Arduino connected to?",
      detail: "Pick the Uno/Nano (or its CH340 / FTDI / CP2102 USB bridge). Never pick a keyboard, mouse or phone.",
      buttons: [...choices.map(describe), "Cancel"],
      cancelId: choices.length,
      noLink: true,
    };
    void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(({ response }) => {
      const port = choices[response];
      finish(port?.portId ?? "", port ? describe(port) : "cancelled");
    });
  });

  // 'serial' and everything else the web app asks for (camera for photos, clipboard) is granted to the app origin only.
  session.setPermissionCheckHandler((_webContents, _permission, requestingOrigin) => trusted(requestingOrigin));
  session.setDevicePermissionHandler((details) => details.deviceType === "serial" && trusted(details.origin));
  session.setPermissionRequestHandler((webContents, _permission, callback, details) => {
    callback(trusted(details.requestingUrl ?? webContents?.getURL()));
  });
  return state;
}
