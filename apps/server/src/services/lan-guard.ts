import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database as SqliteDatabase } from "better-sqlite3";

const COOKIE_NAME = "vb_pair";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;
const PAIRING_FILE = "lan-pairing.json";
const PAIRING_MESSAGE = "This ViBread runs on someone's laptop. To open it on this phone, scan the QR code on that laptop (Steps tab, or ViBread → Show phone link).";

interface PairingFile {
  version: 1;
  secret: string;
}

interface DeviceRow {
  idHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
}

export interface PairedDevice {
  id: string;
  createdAt: string;
  lastSeenAt?: string;
  userAgent?: string;
}

export interface LanGuardOptions {
  dataDir: string;
  singleOperator: boolean;
  pairing?: string;
  sqlite?: SqliteDatabase;
}

export class LanGuard {
  readonly active: boolean;
  private secret: Buffer;
  private readonly pairingPath: string;
  private readonly memoryDevices = new Map<string, DeviceRow>();

  constructor(private readonly options: LanGuardOptions) {
    this.active = options.singleOperator && options.pairing !== "off";
    this.pairingPath = join(options.dataDir, PAIRING_FILE);
    this.secret = this.loadSecret(options.dataDir);
  }

  pairToken(): string {
    return this.digest("pair-v1");
  }

  phonePairQuery(req: Request): string | undefined {
    if (!this.active || !this.isLoopback(req)) return undefined;
    return `pair=${encodeURIComponent(this.pairToken())}`;
  }

  isLoopback(req: Request): boolean {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    const headers = req.headers;
    const forwardedValues = [
      forwardedHeaderValues(headers.forwarded).at(-1),
      forwardedHeaderValues(headers["x-forwarded-for"]).at(-1),
      forwardedHeaderValues(headers["x-real-ip"]).at(-1),
      forwardedHeaderValues(headers.via).at(-1),
    ].filter((value): value is string => value !== undefined);
    return forwardedValues.length === 0 || forwardedValues.every((value) => isLoopbackAddress(stripAddressDecorations(value)));
  }

  listDevices(): PairedDevice[] {
    this.deleteExpiredDevices();
    const rows = this.options.sqlite
      ? (this.options.sqlite.prepare('SELECT * FROM "paired_devices" ORDER BY "createdAt" DESC').all() as DeviceRow[])
      : [...this.memoryDevices.values()].sort((a, b) => b.createdAt - a.createdAt);
    return rows.map((row) => this.deviceView(row));
  }

  unpairAll(): void {
    this.options.sqlite?.prepare('DELETE FROM "paired_devices"').run();
    this.memoryDevices.clear();
    this.secret = randomBytes(32);
    this.writeSecret(this.secret);
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!this.active || this.isLoopback(req) || isBearerRoute(req.path) || isPublicStatic(req.path)) {
        next();
        return;
      }
      const pair = typeof req.query.pair === "string" ? req.query.pair : undefined;
      if (pair && constantTimeEqual(pair, this.pairToken())) {
        const deviceId = randomBytes(32).toString("base64url");
        this.saveDevice(deviceId, req.headers["user-agent"]);
        const cleanUrl = new URL(req.originalUrl, "http://localhost");
        cleanUrl.searchParams.delete("pair");
        const cleanPath = cleanUrl.pathname === "/" ? "/b" : cleanUrl.pathname;
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=${deviceId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`);
        res.redirect(302, `${cleanPath}${cleanUrl.search}${cleanUrl.hash}` || "/b");
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[COOKIE_NAME] && this.touchDevice(cookies[COOKIE_NAME], req.headers["user-agent"])) {
        if (phoneRequestAllowed(req)) {
          next();
        } else {
          denyPhoneScope(req, res);
        }
        return;
      }
      if (req.headers.accept?.includes("text/html")) {
        res.status(403).type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>ViBread pairing required</title><p>${PAIRING_MESSAGE}</p><p><a href="/b">Open Build Mode</a></p>`);
      } else {
        res.status(403).json({ error: { code: "lan_pairing_required", message: PAIRING_MESSAGE } });
      }
    };
  }

  private digest(message: string): string {
    return createHmac("sha256", this.secret).update(message).digest("base64url");
  }

  private loadSecret(dataDir: string): Buffer {
    mkdirSync(dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(this.pairingPath, "utf8")) as Partial<PairingFile>;
      if (parsed.version === 1 && typeof parsed.secret === "string" && parsed.secret.length > 0) return Buffer.from(parsed.secret, "base64url");
    } catch {
      // Generate a new pairing file below when absent or invalid.
    }
    const secret = randomBytes(32);
    this.writeSecret(secret);
    return secret;
  }

  private writeSecret(secret: Buffer): void {
    writeFileSync(this.pairingPath, JSON.stringify({ version: 1, secret: secret.toString("base64url") }) + "\n", { mode: 0o600 });
    chmodSync(this.pairingPath, 0o600);
  }

  private saveDevice(deviceId: string, userAgent: string | string[] | undefined): void {
    const row: DeviceRow = { idHash: hashDeviceId(deviceId), createdAt: Date.now(), lastSeenAt: Date.now(), userAgent: typeof userAgent === "string" ? userAgent : null };
    if (this.options.sqlite) {
      this.options.sqlite.prepare('INSERT OR REPLACE INTO "paired_devices" ("idHash", "createdAt", "lastSeenAt", "userAgent") VALUES (?, ?, ?, ?)').run(row.idHash, row.createdAt, row.lastSeenAt, row.userAgent);
    } else {
      this.memoryDevices.set(row.idHash, row);
    }
  }

  private touchDevice(deviceId: string, userAgent: string | string[] | undefined): boolean {
    const idHash = hashDeviceId(deviceId);
    const now = Date.now();
    const row = this.options.sqlite
      ? (this.options.sqlite.prepare('SELECT * FROM "paired_devices" WHERE "idHash" = ?').get(idHash) as DeviceRow | undefined)
      : this.memoryDevices.get(idHash);
    if (!row || row.createdAt + MAX_AGE_MS <= now) {
      this.options.sqlite?.prepare('DELETE FROM "paired_devices" WHERE "idHash" = ?').run(idHash);
      this.memoryDevices.delete(idHash);
      return false;
    }
    const ua = typeof userAgent === "string" ? userAgent : row.userAgent;
    if (this.options.sqlite) {
      this.options.sqlite.prepare('UPDATE "paired_devices" SET "lastSeenAt" = ?, "userAgent" = ? WHERE "idHash" = ?').run(now, ua, idHash);
    } else {
      row.lastSeenAt = now;
      row.userAgent = ua;
    }
    return true;
  }

  private deleteExpiredDevices(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.options.sqlite?.prepare('DELETE FROM "paired_devices" WHERE "createdAt" <= ?').run(cutoff);
    for (const [idHash, row] of this.memoryDevices) if (row.createdAt <= cutoff) this.memoryDevices.delete(idHash);
  }

  private deviceView(row: DeviceRow): PairedDevice {
    return {
      id: row.idHash,
      createdAt: new Date(row.createdAt).toISOString(),
      ...(row.lastSeenAt === null ? {} : { lastSeenAt: new Date(row.lastSeenAt).toISOString() }),
      ...(row.userAgent ? { userAgent: row.userAgent } : {}),
    };
  }
}

export function createLanGuard(options: LanGuardOptions): LanGuard {
  return new LanGuard(options);
}

const PHONE_SCOPE_MESSAGE = "This phone can only follow the build steps. Use the laptop for everything else.";

function phoneRequestAllowed(req: Request): boolean {
  const path = req.path;
  if (!path.startsWith("/api/")) {
    return req.method === "GET" && (path === "/" || path === "/index.html" || path === "/b" || path.startsWith("/b/") || /\.[A-Za-z0-9]+$/.test(path));
  }
  if (req.method === "GET" && path === "/api/me") return true;
  if (req.method === "GET" && path === "/api/oauth/providers") return true;
  if (req.method === "GET" && /^\/api\/missions\/[^/]+\/build$/.test(path)) return true;
  if (req.method === "POST" && /^\/api\/missions\/[^/]+\/build\/step$/.test(path)) return true;
  if (req.method === "POST" && /^\/api\/missions\/[^/]+\/photo$/.test(path)) return true;
  if (req.method === "GET" && /^\/api\/missions\/[^/]+\/revisions\/[^/]+\/artifacts\/[^/]+$/.test(path)) return true;
  if (req.method === "GET" && /^\/api\/recorded\/[^/]+$/.test(path)) return true;
  return false;
}

function denyPhoneScope(req: Request, res: Response): void {
  if (req.headers.accept?.includes("text/html")) {
    const match = /^\/m\/([^/]+)/.exec(req.path);
    const link = match ? `<p><a href="/b/${encodeURIComponent(match[1])}">Open Build Mode</a></p>` : "";
    res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><title>Build Mode only</title><p>${PHONE_SCOPE_MESSAGE}</p>${link}`);
  } else {
    res.status(403).json({ error: { code: "phone_scope_only", message: PHONE_SCOPE_MESSAGE } });
  }
}

function isPublicStatic(path: string): boolean {
  return path === "/manifest.webmanifest" || path === "/favicon.ico" || path.startsWith("/icons/") || path.startsWith("/icon-");
}

function isBearerRoute(path: string): boolean {
  return path === "/mcp" || path.startsWith("/mcp/") || path === "/a2a" || path.startsWith("/a2a/") || path === "/.well-known" || path.startsWith("/.well-known/");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  return address.startsWith("::ffff:127.");
}

function stripAddressDecorations(value: string): string {
  const trimmed = value.trim().replace(/^for=/i, "").replace(/^\"|\"$/g, "");
  if (trimmed.startsWith("[") && trimmed.includes("]")) return trimmed.slice(1, trimmed.indexOf("]"));
  return trimmed.split(":").length === 2 ? trimmed.slice(0, trimmed.lastIndexOf(":")) : trimmed;
}

function forwardedHeaderValues(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(",") : value;
  if (!joined.trim()) return [];
  if (/^via$/i.test(joined.trim())) return [joined];
  return joined.split(",").map((part) => {
    const match = /for=([^;]+)/i.exec(part);
    return match?.[1]?.trim() ?? part.trim();
  }).filter(Boolean);
}

function hashDeviceId(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    cookies[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return cookies;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
