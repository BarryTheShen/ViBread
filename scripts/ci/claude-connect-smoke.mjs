import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

    // pi-ai's sign-in keeps nothing on disk: the pending login lives in the server, the credential in its database.
    const leftovers = ["claude-accounts", ".omp"].map((name) => join(dataDir, name)).filter((path) => existsSync(path));
    assert(leftovers.length === 0, `Claude sign-in wrote files under DATA_DIR: ${leftovers.join(", ")}`);
    if (process.platform === "win32") {
      const userProfile = process.env.USERPROFILE;
      assert(userProfile, "USERPROFILE is missing on Windows; cannot verify profile isolation");
      const profileToken = join(userProfile, ".omp", "auth-broker.token");
      assert(!existsSync(profileToken), `A Claude sign-in token was written into the Windows profile: ${profileToken}`);
    }
    const pending = await fetch(`${baseUrl}/api/connections`, { headers });
    const connections = await responseBody(pending);
    assert(connections?.claude?.pending?.loginId === loginId, `GET /api/connections doesn't show the pending sign-in: ${describeBody(connections)}`);
    console.log("Claude connect smoke: pending sign-in listed; nothing written to disk or the user profile.");

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
