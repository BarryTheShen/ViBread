import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { LanGuard } from "./lan-guard.js";

function request(path: string, remoteAddress: string, options: { method?: string; accept?: string; query?: Record<string, string>; cookie?: string; headers?: Record<string, string> } = {}): Request {
  return {
    method: options.method ?? "GET",
    path,
    originalUrl: options.query ? `${path}?${new URLSearchParams(options.query).toString()}` : path,
    query: options.query ?? {},
    headers: { accept: options.accept, cookie: options.cookie, ...options.headers },
    socket: { remoteAddress } as Request["socket"],
  } as unknown as Request;
}

function response(): { value: Response; status: number; headers: Record<string, string>; body?: unknown; next: boolean; error?: unknown } {
  const state = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown, next: false, error: undefined as unknown };
  const value = {
    headersSent: false,
    setHeader(name: string, content: string) { state.headers[name.toLowerCase()] = content; return value; },
    status(code: number) { state.status = code; return value; },
    type(_type: string) { return value; },
    send(body: unknown) { state.body = body; return value; },
    json(body: unknown) { state.body = body; return value; },
    redirect(code: number, location: string) { state.status = code; state.headers.location = location; return value; },
  } as unknown as Response;
  return {
    value,
    get status() { return state.status; },
    headers: state.headers,
    get body() { return state.body; },
    next: false,
    error: undefined,
  };
}

describe("LAN pairing guard", () => {
  it("allows loopback and bearer routes, rejects LAN JSON/HTML, and pairs with a query token", () => {
    const dir = `/tmp/vb-lan-${randomUUID()}`;
    const guard = new LanGuard({ dataDir: dir, singleOperator: true });
    try {
      const local = response();
      guard.middleware()(request("/api/me", "127.0.0.1"), local.value, () => { local.next = true; });
      expect(local.next).toBe(true);
      const mcp = response();
      guard.middleware()(request("/mcp", "192.168.1.20"), mcp.value, () => { mcp.next = true; });
      expect(mcp.next).toBe(true);
      const blocked = response();
      guard.middleware()(request("/api/me", "192.168.1.20", { accept: "application/json" }), blocked.value, () => { blocked.next = true; });
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ error: { code: "lan_pairing_required" } });
      const html = response();
      guard.middleware()(request("/", "192.168.1.20", { accept: "text/html" }), html.value, () => { html.next = true; });
      expect(html.status).toBe(403);
      expect(String(html.body)).toContain("scan the QR code");
      const paired = response();
      guard.middleware()(request("/b/mission", "192.168.1.20", { query: { pair: guard.pairToken() } }), paired.value, () => { paired.next = true; });
      expect(paired.status).toBe(302);
      expect(paired.headers["set-cookie"]).toContain("vb_pair=");
      expect(paired.headers.location).toBe("/b/mission");
      const cookie = paired.headers["set-cookie"].split(";")[0]!;
      const cookieRequest = response();
      guard.middleware()(request("/b/mission", "192.168.1.20", { cookie }), cookieRequest.value, () => { cookieRequest.next = true; });
      expect(cookieRequest.next).toBe(true);
      const forged = response();
      guard.middleware()(request("/b/mission", "192.168.1.20", { cookie: "vb_pair=forged" }), forged.value, () => { forged.next = true; });
      expect(forged.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses per-device cookies, respects expiry and proxy headers, and rotates on unpair-all", () => {
    vi.useFakeTimers();
    const dir = `/tmp/vb-lan-${randomUUID()}`;
    const guard = new LanGuard({ dataDir: dir, singleOperator: true });
    try {
      const first = response();
      guard.middleware()(request("/", "192.168.1.20", { query: { pair: guard.pairToken() } }), first.value, () => { first.next = true; });
      const firstCookie = first.headers["set-cookie"].split(";")[0]!;
      const second = response();
      guard.middleware()(request("/", "192.168.1.20", { query: { pair: guard.pairToken() } }), second.value, () => { second.next = true; });
      const secondCookie = second.headers["set-cookie"].split(";")[0]!;
      expect(secondCookie).not.toBe(firstCookie);
      expect(guard.listDevices()).toHaveLength(2);
      const spoofed = response();
      guard.middleware()(request("/", "127.0.0.1", { headers: { "x-forwarded-for": "192.168.1.20" } }), spoofed.value, () => { spoofed.next = true; });
      expect(spoofed.status).toBe(403);
      const forwardedLoopback = response();
      guard.middleware()(request("/", "127.0.0.1", { headers: { "x-forwarded-for": "127.0.0.1" } }), forwardedLoopback.value, () => { forwardedLoopback.next = true; });
      expect(forwardedLoopback.next).toBe(true);
      vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000 + 1);
      const expired = response();
      guard.middleware()(request("/", "192.168.1.20", { cookie: firstCookie }), expired.value, () => { expired.next = true; });
      expect(expired.status).toBe(403);
      expect(guard.listDevices()).toHaveLength(0);
      vi.useRealTimers();
      const oldPair = guard.pairToken();
      guard.unpairAll();
      expect(guard.pairToken()).not.toBe(oldPair);
      expect(guard.listDevices()).toEqual([]);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("restricts paired LAN devices to the Build Mode phone scope", () => {
    const dir = `/tmp/vb-lan-${randomUUID()}`;
    const guard = new LanGuard({ dataDir: dir, singleOperator: true });
    try {
      const paired = response();
      guard.middleware()(request("/b/mission", "192.168.1.20", { query: { pair: guard.pairToken() } }), paired.value, () => { paired.next = true; });
      const cookie = paired.headers["set-cookie"].split(";")[0]!;
      for (const [method, path] of [["GET", "/api/missions/m/build"], ["POST", "/api/missions/m/build/step"], ["POST", "/api/missions/m/build/wire-color"], ["GET", "/api/missions/m/build/steps/3.png"], ["GET", "/api/missions/m/build/schematic.svg"], ["POST", "/api/missions/m/photo"], ["GET", "/api/missions/m/revisions/1/artifacts/step-1.png"], ["GET", "/api/recorded/example.png"], ["GET", "/api/me"], ["GET", "/api/oauth/providers"]] as const) {
        const allowed = response();
        guard.middleware()(request(path, "192.168.1.20", { method, cookie }), allowed.value, () => { allowed.next = true; });
        expect(allowed.next, `${method} ${path}`).toBe(true);
      }
      for (const path of ["/api/connections", "/api/missions/m", "/api/missions/m/chat", "/api/missions/m/bench/requests", "/api/lan/devices"]) {
        const denied = response();
        guard.middleware()(request(path, "192.168.1.20", { cookie }), denied.value, () => { denied.next = true; });
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ error: { code: "phone_scope_only" } });
      }
      const html = response();
      guard.middleware()(request("/settings", "192.168.1.20", { accept: "text/html", cookie }), html.value, () => { html.next = true; });
      expect(html.status).toBe(403);
      expect(String(html.body)).toContain("Build Mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
