import { useCallback, useEffect, useState } from "react";

/**
 * Native flashing (issue #20): when this page is served by the ViBread server on the computer the board is plugged
 * into, the server uploads with its bundled arduino-cli (avrdude, the Arduino IDE's uploader) instead of Web Serial.
 * `GET /api/bench/ports` only answers requests from that computer, so a successful listing is what "available" means.
 */

/** A plugged-in port with a known Arduino / USB-serial bridge ID (server: services/native-flash.ts). */
export interface BenchPort {
  port: string;
  label: string;
  vid: number;
  pid: number;
  boardFqbn?: string;
}

export interface NativeFlashFailure {
  code: string;
  message: string;
  hint?: string;
}

export type NativeFlashOutcome =
  | { ok: true; output: string; fqbn: string; durationMs: number; calibration?: "measured" | "default"; /** The bootloader speed that answered (the server tries the other one when the first gets no answer). */ baud?: number }
  | { ok: false; error: NativeFlashFailure; output: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** The ports the server's arduino-cli sees, or undefined when native flashing isn't available from this page. */
export async function fetchBenchPorts(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<BenchPort[] | undefined> {
  try {
    const response = await fetcher("/api/bench/ports");
    if (!response.ok) return undefined;
    const body = (await response.json()) as { ports?: unknown };
    return Array.isArray(body.ports) ? (body.ports as BenchPort[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Uploads the mission's bench/app HEX through the server; a classified failure comes back as `ok: false`. */
export async function nativeFlash(
  missionId: string,
  input: { port: string; which: "bench" | "app"; board?: string },
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<NativeFlashOutcome> {
  const response = await fetcher(`/api/missions/${encodeURIComponent(missionId)}/bench/native-flash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => undefined)) as { ok?: boolean; output?: unknown; fqbn?: unknown; durationMs?: unknown; calibration?: unknown; baud?: unknown; error?: Partial<NativeFlashFailure> } | undefined;
  const output = typeof body?.output === "string" ? body.output : "";
  if (response.ok && body?.ok === true) {
    const calibration = body.calibration === "measured" || body.calibration === "default" ? body.calibration : undefined;
    return {
      ok: true,
      output,
      fqbn: typeof body.fqbn === "string" ? body.fqbn : "",
      durationMs: typeof body.durationMs === "number" ? body.durationMs : 0,
      ...(calibration ? { calibration } : {}),
      ...(typeof body.baud === "number" ? { baud: body.baud } : {}),
    };
  }
  const error = body?.error;
  return {
    ok: false,
    output,
    error: {
      code: typeof error?.code === "string" ? error.code : `http_${response.status}`,
      message: typeof error?.message === "string" && error.message ? error.message : `The flash request failed (${response.status}).`,
      ...(typeof error?.hint === "string" ? { hint: error.hint } : {}),
    },
  };
}

/**
 * The port to preselect: the current choice while it's still plugged in, else the one port with the Web Serial board's
 * USB ID, else the only port listed.
 */
export function preferredPort(ports: readonly BenchPort[], current: string | undefined, usb?: { usbVendorId?: number; usbProductId?: number }): string | undefined {
  if (current && ports.some((candidate) => candidate.port === current)) return current;
  const sameUsb = usb ? ports.filter((candidate) => candidate.vid === usb.usbVendorId && candidate.pid === usb.usbProductId) : [];
  if (sameUsb.length === 1) return sameUsb[0].port;
  return ports.length === 1 ? ports[0].port : undefined;
}

/** Native flashing state for the bench: listed ports (undefined = unavailable), refresh, and the chosen port. */
export function useBenchPorts(enabled: boolean, usb?: { usbVendorId?: number; usbProductId?: number }): {
  ports: BenchPort[] | undefined;
  port: string | undefined;
  setPort: (port: string) => void;
  refresh: () => Promise<void>;
  refreshing: boolean;
} {
  const [ports, setPorts] = useState<BenchPort[]>();
  const [port, setPort] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      setPorts(await fetchBenchPorts());
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  const vendor = usb?.usbVendorId;
  const product = usb?.usbProductId;
  useEffect(() => {
    if (ports) setPort((current) => preferredPort(ports, current, { usbVendorId: vendor, usbProductId: product }));
  }, [ports, vendor, product]);
  return { ports: enabled ? ports : undefined, port, setPort, refresh, refreshing };
}
