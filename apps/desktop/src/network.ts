import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Resolves `preferred` if it is free, otherwise a free port the OS hands out. "Free" means both the wildcard address
 * the server binds and 127.0.0.1, which the window loads: Windows lets 0.0.0.0:<port> bind while another program holds
 * 127.0.0.1:<port>, and the window would then reach that program instead of ViBread.
 */
export async function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number, host: string) =>
    new Promise<number | undefined>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(undefined));
      probe.listen({ port, host, exclusive: true }, () => {
        const address = probe.address();
        const chosen = typeof address === "object" && address ? address.port : undefined;
        probe.close(() => resolve(chosen));
      });
    });
  const free = async (port: number) => {
    const chosen = await tryListen(port, "0.0.0.0");
    return chosen === undefined ? undefined : tryListen(chosen, "127.0.0.1");
  };
  const first = await free(preferred);
  if (first !== undefined) return first;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await free(0);
    if (port !== undefined) return port;
  }
  throw new Error("no free TCP port");
}

const VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|tailscale|wg|awdl|llw|bridge|vEthernet)/i;

/** Primary non-internal LAN IPv4 (skips loopback, link-local, Docker/VM/VPN adapters); undefined when offline. */
export function lanIPv4(): string | undefined {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family !== "IPv4" || info.internal || info.address.startsWith("169.254.")) continue;
      candidates.push({ name, address: info.address });
    }
  }
  const physical = candidates.filter((candidate) => !VIRTUAL.test(candidate.name));
  const privateRange = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  return (physical.find((c) => privateRange.test(c.address)) ?? physical[0] ?? candidates[0])?.address;
}
