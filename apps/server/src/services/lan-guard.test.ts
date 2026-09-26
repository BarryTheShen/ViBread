import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { LanGuard } from "./lan-guard.js";

function request(path: string, remoteAddress: string, options: { accept?: string; query?: Record<string, string>; cookie?: string } = {}): Request {
  return {
    path,
    originalUrl: options.query ? `${path}?${new URLSearchParams(options.query).toString()}` : path,
    query: options.query ?? {},
    headers: { accept: options.accept, cookie: options.cookie },
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
});
