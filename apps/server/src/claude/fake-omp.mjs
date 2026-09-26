#!/usr/bin/env node
// Test double for the oh-my-pi CLI surface ClaudeAccountService drives (accounts.test.ts): `--version`,
// `auth-broker serve`, `login anthropic`, `auth-gateway serve`. Mirrors the real output/prompt, HTTP routes, bearer
// checks and token files; the broker's credential rows live in $HOME/fake-broker.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { join } from "node:path";

const home = process.env.HOME;
const ompDir = join(home, ".omp");
const store = join(home, "fake-broker.json");
const args = process.argv.slice(2);
const bindPort = () => Number(args.find((arg) => arg.startsWith("--bind="))?.split(":").pop());
const rows = () => {
  try {
    return JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return [];
  }
};
const saveRows = (value) => writeFileSync(store, JSON.stringify(value));
const token = (name) => {
  mkdirSync(ompDir, { recursive: true });
  const path = join(ompDir, name);
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    const value = `tok-${name}-${process.pid}`;
    writeFileSync(path, value);
    return value;
  }
};
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

if (args[0] === "--version") {
  console.log("omp/fake");
} else if (args[0] === "auth-broker" && args[1] === "serve") {
  const bearer = `Bearer ${token("auth-broker.token")}`;
  createServer((req, res) => {
    if (req.url === "/v1/healthz") return json(res, 200, { ok: true });
    if (req.headers.authorization !== bearer) return json(res, 401, { error: "unauthorized" });
    if (req.url === "/v1/snapshot") return json(res, 200, { credentials: rows().filter((row) => !row.disabled) });
    const disable = /^\/v1\/credential\/(\d+)\/disable$/.exec(req.url ?? "");
    if (disable && req.method === "POST") {
      saveRows(rows().map((row) => (row.id === Number(disable[1]) ? { ...row, disabled: true } : row)));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  }).listen(bindPort(), "127.0.0.1");
} else if (args[0] === "login" && args[1] === "anthropic") {
  if (!process.env.OMP_AUTH_BROKER_URL || !process.env.OMP_AUTH_BROKER_TOKEN) process.exit(2);
  console.log("\nOpen this URL in your browser:");
  console.log("https://claude.ai/oauth/authorize?client_id=fake&response_type=code&state=abc&code=true");
  process.stdout.write("Paste the authorization code (or full redirect URL): ");
  createInterface({ input: process.stdin }).once("line", (line) => {
    if (line.trim() !== "good-code") {
      console.log("Login failed: invalid authorization code");
      process.exit(1);
    }
    const all = rows();
    all.push({ id: all.length + 1, provider: "anthropic", identityKey: `email:user${all.length + 1}@example.com`, credential: { type: "oauth", email: `user${all.length + 1}@example.com` }, rotatesInMs: null });
    saveRows(all);
    console.log("Logged in");
    process.exit(0);
  });
} else if (args[0] === "auth-gateway" && args[1] === "serve") {
  const bearer = `Bearer ${token("auth-gateway.token")}`;
  const pool = JSON.parse(readFileSync(process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE, "utf8")).anthropic;
  createServer((req, res) => {
    if (req.url === "/healthz") return json(res, 200, { ok: true });
    if (req.headers.authorization !== bearer) return json(res, 401, { error: "unauthorized" });
    const usable = rows().some((row) => !row.disabled && pool.includes(row.identityKey));
    if (req.url === "/v1/models") return json(res, 200, { object: "list", data: usable ? [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5" }] : [] });
    json(res, 404, { error: "not found" });
  }).listen(bindPort(), "127.0.0.1");
} else {
  process.exit(64);
}
