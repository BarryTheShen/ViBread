import { describe, expect, it, vi } from "vitest";
import type { ScanView } from "@vibread/core";

function scanView(photos: number): ScanView {
  return { id: "scan-1", status: "waiting", photos, items: [], claude: "connected", createdAt: "2026-09-26T00:00:00.000Z" };
}

describe("paired phone scan polling", () => {
  it("updates laptop 0 → 1 after the paired-phone photo upload while the laptop is occluded", async () => {
    // Query Core disables timers in a Node/server environment. Provide the tiny browser globals before importing it.
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const { focusManager, QueryClient, QueryObserver } = await import("@tanstack/react-query");
    const { scanQueryOptions } = await import("./inventory.js");
    let serverView = scanView(0);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The real laptop query options, with only the network call replaced by the server's current view.
    const observer = new QueryObserver(client, { ...scanQueryOptions("scan-1"), queryFn: async () => serverView });
    let latest: ScanView | undefined;
    const unsubscribe = observer.subscribe((result) => {
      latest = result.data;
    });
    await observer.refetch();
    expect(latest?.photos).toBe(0);
    focusManager.setFocused(false);
    serverView = scanView(1); // paired-phone POST /photos has committed on the server
    await vi.waitFor(() => expect(latest?.photos).toBe(1), { timeout: 1_900, interval: 25 });
    expect(latest?.status).toBe("waiting");
    unsubscribe();
    client.clear();
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
  });
});
