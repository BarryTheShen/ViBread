import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const port = process.env.PORT ?? "8787";
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const origin = process.env.ORIGIN ?? `http://localhost:${port}`;
const dataDir = process.env.DATA_DIR;

const headers = {
  accept: "*/*",
  "content-type": "application/json",
  origin,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function showsPiFlow(value, key = "") {
  if (typeof value === "boolean") return value && /pi[-_ ]?ai|piBased/i.test(key);
  if (typeof value === "string") return /flow|provider|implementation|backend|engine|auth|kind|mode|using/i.test(key) && /\bpi(?:[-_ ]?ai)?\b/i.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) => showsPiFlow(child, childKey));
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeBody(body) {
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

function printLogTail() {
  const paths = [process.env.SERVER_LOG, process.env.SERVER_ERROR_LOG].filter(Boolean);
  for (const path of paths) {
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      console.error(`--- ${path} (tail) ---`);
      console.error(lines.slice(-120).join("\n"));
    } catch (error) {
      console.error(`--- unable to read ${path}: ${error instanceof Error ? error.message : String(error)} ---`);
    }
  }
}

async function smoke() {
  assert(dataDir, "DATA_DIR must point to the server's isolated data directory");
  console.log(`Claude connect smoke: POST ${baseUrl}/api/connections/claude/start (Origin ${origin})`);
  const started = await post("/api/connections/claude/start", {});
  const startBody = started.body;
  let loginId;
  let cancelled = false;
  try {
    assert(started.response.status === 201, `Claude start returned ${started.response.status}: ${describeBody(startBody)}`);
    assert(startBody && typeof startBody === "object", `Claude start did not return JSON: ${describeBody(startBody)}`);
    loginId = startBody.loginId;
    assert(typeof loginId === "string" && loginId.length > 0, `Claude start response has no loginId: ${describeBody(startBody)}`);
    assert(typeof startBody.url === "string" && startBody.url.startsWith("https://claude.ai/oauth/authorize"), `Claude start URL was not a Claude OAuth URL: ${describeBody(startBody)}`);
    console.log(`Claude connect smoke: start returned 201 and ${startBody.url}`);

    const claudeHome = resolve(dataDir, "claude-accounts");
    const ompDir = join(claudeHome, ".omp");
    if (showsPiFlow(startBody)) {
      console.log("Claude connect smoke: pi-based flow reported; skipped omp broker token path assertions.");
    } else if (!isDirectory(ompDir)) {
      console.log(`Claude connect smoke: no omp broker directory at ${ompDir}; skipped omp broker token path assertions.`);
    } else {
      const isolatedToken = join(ompDir, "auth-broker.token");
      console.log(`Claude connect smoke: omp broker flow; checking isolated token ${isolatedToken}`);
      assert(existsSync(isolatedToken), `Expected isolated omp broker token at ${isolatedToken}`);
      if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE;
        assert(userProfile, "USERPROFILE is missing on Windows; cannot verify profile isolation");
        const profileToken = join(userProfile, ".omp", "auth-broker.token");
        assert(!existsSync(profileToken), `omp broker token leaked into the Windows profile: ${profileToken}`);
        console.log(`Claude connect smoke: Windows profile token absent (${profileToken}); isolated token present.`);
      } else {
        console.log("Claude connect smoke: Linux profile-token check skipped; isolated token present.");
      }
    }

    const cancelledResponse = await post("/api/connections/claude/cancel", { loginId });
    assert(cancelledResponse.response.status === 200, `Claude cancel returned ${cancelledResponse.response.status}: ${describeBody(cancelledResponse.body)}`);
    cancelled = true;
    console.log("Claude connect smoke: cancel returned 200.");
  } finally {
    if (loginId && !cancelled) {
      try {
        const cleanup = await post("/api/connections/claude/cancel", { loginId });
        if (cleanup.response.ok) console.log("Claude connect smoke: cancelled pending login during failure cleanup.");
        else console.error(`Claude connect smoke: failure cleanup cancel returned ${cleanup.response.status}: ${describeBody(cleanup.body)}`);
      } catch (error) {
        console.error(`Claude connect smoke: failure cleanup cancel failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

try {
  await smoke();
  console.log("Claude connect smoke: PASS");
} catch (error) {
  console.error(`Claude connect smoke: FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  printLogTail();
  process.exitCode = 1;
}
