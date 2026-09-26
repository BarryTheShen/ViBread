import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

/** Resolves `preferred` if it is free on all interfaces, otherwise any free port the OS hands out. */
export async function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(undefined));
      probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
        const address = probe.address();
        const chosen = typeof address === "object" && address ? address.port : undefined;
        probe.close(() => resolve(chosen));
      });
    });
  return (await tryListen(preferred)) ?? (await tryListen(0)) ?? Promise.reject(new Error("no free TCP port"));
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
