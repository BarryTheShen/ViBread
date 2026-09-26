import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const COOKIE_NAME = "vb_pair";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PAIRING_FILE = "lan-pairing.json";
const PAIRING_MESSAGE = "This ViBread runs on someone's laptop. To open it on this phone, scan the QR code on that laptop (Steps tab, or ViBread → Show phone link).";

interface PairingFile {
  version: 1;
  secret: string;
}

export interface LanGuardOptions {
  dataDir: string;
  singleOperator: boolean;
  pairing?: string;
}

export class LanGuard {
  readonly active: boolean;
  private readonly secret: Buffer;

  constructor(private readonly options: LanGuardOptions) {
    this.active = options.singleOperator && options.pairing !== "off";
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
    return isLoopbackAddress(req.socket.remoteAddress);
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!this.active || this.isLoopback(req) || isBearerRoute(req.path)) {
        next();
        return;
      }
      const pair = typeof req.query.pair === "string" ? req.query.pair : undefined;
      if (pair && constantTimeEqual(pair, this.pairToken())) {
        const cleanUrl = new URL(req.originalUrl, "http://localhost");
        cleanUrl.searchParams.delete("pair");
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=${this.digest("device-v1")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`);
        res.redirect(302, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}` || "/");
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[COOKIE_NAME] && constantTimeEqual(cookies[COOKIE_NAME], this.digest("device-v1"))) {
        next();
        return;
      }
      if (req.headers.accept?.includes("text/html")) {
        res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><title>ViBread pairing required</title><p>${PAIRING_MESSAGE}</p>`);
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
    const path = join(dataDir, PAIRING_FILE);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PairingFile>;
      if (parsed.version === 1 && typeof parsed.secret === "string" && parsed.secret.length > 0) return Buffer.from(parsed.secret, "base64url");
    } catch {
      // Generate a new pairing file below when the existing one is absent or invalid.
    }
    const secret = randomBytes(32);
    writeFileSync(path, JSON.stringify({ version: 1, secret: secret.toString("base64url") }) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    return secret;
  }
}

export function createLanGuard(options: LanGuardOptions): LanGuard {
  return new LanGuard(options);
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
