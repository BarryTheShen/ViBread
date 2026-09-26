// ViBread end-to-end benchmark with real Claude models (method and results: docs/e2e-benchmark.md).
//
// Needs: the oh-my-pi `omp` CLI on PATH with Anthropic model access (anthropic/claude-opus-5-5, anthropic/claude-sonnet-5),
// the Arduino toolchain (`npm run setup:toolchain`), and free ports for ViBread (default 8950) and the model bridge
// (default 8951). Run from the repo root:
//
//   npx tsx scripts/e2e-benchmark.mts [--only moon-phase-lamp,doorbell] [--resume key,…] [--parallel 1] [--out /tmp/promptlab-e2e]
//
// Per brief: create a mission (REST) → the design agent (Opus 5.5 in `omp -p`, ViBread's exact designSystemPrompt, ViBread's
// tools over MCP like a user's Claude Code) proposes and iterates → inside ViBread every propose_design runs EECOM, GUIDO,
// the independent test author + FIDO, FAO and RETRO (ViBread's own agent code; its Anthropic calls are served by Sonnet 5
// through the bridge below) → human GO for build (REST) → virtual bench self-test with a scripted person → one injected
// wiring fault → diagnosis rank. Results: <out>/<key>/result.json and <out>/summary.md.
//
// The bridge: ViBread's server talks to Anthropic through the AI SDK. This script points it (ANTHROPIC_BASE_URL) at a local
// Anthropic Messages endpoint that runs each non-streaming request as one `omp -p` call on the same model and returns the
// reply as a Messages response. omp print mode has no structured-output parameter, so the request's JSON Schema is appended
// to the prompt and the JSON object is taken from the reply (production uses Anthropic's native structured outputs).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { GOLDEN } from "@vibread/fixtures";
import { applyFault, LineDecoder, type FaultId } from "@vibread/bench";
import { SimSession } from "@vibread/sim/browser";
import type { BenchRunResult, Circuit, DeviceLine, InventoryItem, MissionDetail, RevisionDetail, SelfTestPlan } from "@vibread/core";
import { designSystemPrompt } from "../apps/server/src/agents/prompts.js";

const REPO = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const OUT = flag("out", "/tmp/promptlab-e2e");
const PORT = Number(flag("port", "8950"));
const BRIDGE_PORT = Number(flag("bridge-port", "8951"));
// One design run at a time by default: concurrent omp starts once corrupted omp's shared credential store (agent.db).
const PARALLEL = Number(flag("parallel", "1"));
const ONLY = flag("only", "").split(",").filter(Boolean);
/** Re-run only GO for build + bench for briefs whose <out>/<key>/result.json already holds a design (same DATA_DIR). */
const RESUME = flag("resume", "").split(",").filter(Boolean);
const DATA_DIR = flag("data-dir", join(OUT, "data"));
const API = `http://127.0.0.1:${PORT}`;
const DESIGN_MODEL = "anthropic/claude-opus-5-5";

interface Brief {
  key: string;
  brief: string;
  inventory: InventoryItem[];
}
const led = (color: string, count: number): InventoryItem => ({ module: "led", count, params: { color } });
const res = (ohms: number, count: number): InventoryItem => ({ module: "resistor", count, params: { ohms } });
const BRIEFS: Brief[] = [
  ...GOLDEN.map((g) => ({ key: g.key, brief: g.brief, inventory: g.inventory })),
  {
    key: "traffic-light",
    brief: "A traffic light for my toy cars: red, yellow and green lights cycle like a real traffic light. When someone presses the walk button, it finishes the cycle safely to red and stays red a bit longer so they can cross.",
    inventory: [led("red", 2), led("yellow", 2), led("green", 2), res(220, 6), res(10_000, 2), { module: "button", count: 2 }],
  },
  {
    key: "reaction-game",
    brief: "A reaction-time game: after a random wait a light turns on and I press the button as fast as I can. If I was fast the buzzer beeps once; if I pressed before the light came on, it buzzes long.",
    inventory: [led("red", 2), led("green", 2), res(220, 5), { module: "button", count: 2 }, { module: "buzzer-active", count: 1 }],
  },
  {
    key: "knob-chaser",
    brief: "Five lights in a row that chase from left to right over and over, and turning the knob changes how fast they chase.",
    inventory: [led("red", 6), res(220, 8), { module: "potentiometer", count: 1, params: { ohms: 10_000 } }],
  },
  {
    key: "doorbell",
    brief: "A doorbell: when someone presses the button, the buzzer plays a short ding-dong tune and a light blinks while it plays.",
    inventory: [{ module: "buzzer-passive", count: 1 }, { module: "button", count: 1 }, led("yellow", 2), res(220, 4), res(100, 2)],
  },
  {
    key: "dusk-lamp",
    brief: "A lamp that fades on gently as the room gets dark: the darker the room, the brighter the light.",
    inventory: [led("white", 2), res(220, 3), res(10_000, 2), { module: "photoresistor", count: 1 }],
  },
  {
    key: "sos-blinker",
    brief: "An SOS blinker: press the button to start flashing S-O-S in Morse code with a red light, press it again to stop.",
    inventory: [led("red", 2), res(220, 3), { module: "button", count: 1 }],
  },
  {
    key: "quick-press",
    brief: "A two-player quick-press game: each player has a button and a light. When the green GO light comes on, whoever presses first gets their light lit and the buzzer beeps. Pressing before GO doesn't count.",
    inventory: [led("red", 3), led("green", 2), res(220, 6), { module: "button", count: 3 }, { module: "buzzer-active", count: 1 }],
  },
];

const now = () => new Date().toISOString().slice(11, 19);
const log = (...parts: unknown[]) => console.log(`[${now()}]`, ...parts);

// ---------- child processes ----------

/** omp processes share ~/.omp/agent/agent.db; never start two within OMP_START_GAP_MS of each other. */
const OMP_START_GAP_MS = 5_000;
let ompGate: Promise<void> = Promise.resolve();

async function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdoutFile?: string }): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  if (cmd === "omp") {
    const turn = ompGate;
    ompGate = turn.then(() => new Promise((r) => setTimeout(r, OMP_START_GAP_MS)));
    await turn;
  }
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", async (code) => {
      if (opts.stdoutFile) await writeFile(opts.stdoutFile, stdout);
      resolve({ code: code ?? -1, stdout, stderr, ms: performance.now() - started });
    });
  });
}

interface OmpTranscript {
  text: string;
  toolCalls: string[];
  tokens: number;
  costUsd: number;
}
/** Parse `omp --mode json` output: final assistant text, tool calls by name, summed usage. */
function parseOmp(jsonl: string): OmpTranscript {
  const out: OmpTranscript = { text: "", toolCalls: [], tokens: 0, costUsd: 0 };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; cost?: { total?: number } } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.message;
    if (event.type !== "message_end" || message?.role !== "assistant") continue;
    out.tokens += message.usage?.totalTokens ?? 0;
    out.costUsd += message.usage?.cost?.total ?? 0;
    const content = Array.isArray(message.content) ? (message.content as { type: string; text?: string; name?: string; arguments?: unknown }[]) : [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    if (text) out.text = text;
    for (const c of content) if (c.type === "toolCall") out.toolCalls.push(`${c.name}:${JSON.stringify(c.arguments ?? {}).match(/xd:\/\/mcp__vibread_(\w+)/)?.[1] ?? ""}`);
  }
  return out;
}

// ---------- Anthropic Messages bridge (ViBread's own agents → omp -p) ----------

interface BridgeCall {
  role: "test-author" | "retro" | "photo" | "other";
  model: string;
  ms: number;
  tokens: number;
  costUsd: number;
  ok: boolean;
  error?: string;
  prompt: string;
}
const bridgeCalls: BridgeCall[] = [];

function jsonObjectText(text: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.stringify(JSON.parse(body));
}

type Block = { type: string; text?: string };
async function bridgeHandle(req: IncomingMessage, response: ServerResponse): Promise<void> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const fail = (status: number, message: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: status === 400 ? "invalid_request_error" : "api_error", message } }));
  };
  if (req.method !== "POST" || !req.url?.endsWith("/messages")) return fail(404, "only POST /v1/messages is bridged");
  const body = JSON.parse(raw) as {
    model: string;
    stream?: boolean;
    system?: string | Block[];
    messages: { role: string; content: string | Block[] }[];
    output_config?: { format?: { type?: string; schema?: unknown } };
    tools?: { name: string; input_schema?: unknown }[];
    tool_choice?: { type: string; name?: string };
  };
  if (body.stream) return fail(400, "the benchmark bridge serves non-streaming requests only");
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
  const parts: string[] = [];
  for (const m of body.messages) {
    for (const block of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) {
      if (block.type !== "text") return fail(400, `the benchmark bridge does not forward ${block.type} blocks`);
      parts.push(block.text ?? "");
    }
  }
  const forcedTool = body.tool_choice?.type === "tool" ? body.tools?.find((t) => t.name === body.tool_choice?.name) : undefined;
  const schema = body.output_config?.format?.schema ?? forcedTool?.input_schema;
  let prompt = parts.join("\n\n");
  if (schema) prompt += `\n\nReply with ONLY the JSON object, matching this JSON Schema:\n${JSON.stringify(schema)}`;
  const role: BridgeCall["role"] = system.startsWith("You are ViBread's independent test author")
    ? "test-author"
    : system.startsWith("You are RETRO")
      ? "retro"
      : system.startsWith("You check a phone photo")
        ? "photo"
        : "other";
  const model = body.model.includes("/") ? body.model : `anthropic/${body.model}`;
  const args = ["-p", "--no-session", "--no-title", "--no-tools", "--no-rules", "--no-skills", "--no-extensions", "--model", model, "--max-time", "10m", "--mode", "json", "--system-prompt", system, prompt];
  const result = await run("omp", args, { cwd: OUT });
  const transcript = parseOmp(result.stdout);
  const call: BridgeCall = { role, model, ms: Math.round(result.ms), tokens: transcript.tokens, costUsd: transcript.costUsd, ok: false, prompt: parts.join("\n\n") };
  bridgeCalls.push(call);
  if (result.code !== 0 || !transcript.text) {
    call.error = `omp exit ${result.code}: ${result.stderr.slice(-400)}`;
    return fail(500, call.error);
  }
  let text = transcript.text;
  if (schema) {
    try {
      text = jsonObjectText(text);
    } catch {
      call.error = "reply had no JSON object";
    }
  }
  call.ok = !call.error;
  const usage = { input_tokens: 0, output_tokens: transcript.tokens };
  const content = forcedTool && call.ok ? [{ type: "tool_use", id: `toolu_bridge_${bridgeCalls.length}`, name: forcedTool.name, input: JSON.parse(text) }] : [{ type: "text", text }];
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: `msg_bridge_${bridgeCalls.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason: forcedTool ? "tool_use" : "end_turn", stop_sequence: null, usage }));
}

// ---------- ViBread REST ----------

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const init = { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  // The simulator runs synchronously for seconds between requests, so a kept-alive socket can be closed by the server
  // (5 s keep-alive) before undici notices; such a request never reached the server and is safe to send again.
  const r = await fetch(`${API}${path}`, init).catch(() => fetch(`${API}${path}`, init));
  const text = await r.text();
  return { status: r.status, json: (text ? JSON.parse(text) : null) as T };
}

// ---------- virtual bench (scripted person; same answers as packages/bench virtual-bench.test.ts) ----------

function virtualSelfTest(circuit: Circuit, plan: SelfTestPlan, hex: string): { lines: DeviceLine[]; answers: Record<string, string> } {
  const light = Object.fromEntries(circuit.parts.filter((p) => p.module === "photoresistor").map((p) => [p.id, 0.8]));
  const session = new SimSession({ circuit, hex, light });
  const decoder = new LineDecoder();
  const lines: DeviceLine[] = [];
  const answers: Record<string, string> = {};
  const pending: Extract<DeviceLine, { t: "ask" }>[] = [];
  // Asks are answered between simulator slices, never from inside the serial callback: calling session.run() re-entrantly
  // there (as virtual-bench.test.ts and faults.ts runWithSession do) stalls the LED sequence for some designs.
  session.onSerial((chunk) => {
    for (const decoded of decoder.push(chunk)) {
      if (decoded.t === "invalid") continue;
      lines.push(decoded);
      if (decoded.t === "ask" && !(decoded.id in answers)) pending.push(decoded);
    }
  });
  const answer = (ask: Extract<DeviceLine, { t: "ask" }>) => {
    if (ask.id in answers) return;
    if (ask.id.endsWith("-press")) session.setDigital(ask.part ?? "BTN1", true);
    if (ask.id.endsWith("-release")) session.setDigital(ask.part ?? "BTN1", false);
    if (ask.id.endsWith("-cover")) session.setLight(ask.part ?? "LDR1", 0.05);
    if (ask.id.endsWith("-uncover")) session.setLight(ask.part ?? "LDR1", 0.8);
    if (ask.id.startsWith("pot") && ask.id.endsWith("-min")) session.setAnalog(ask.part ?? "POT1", 0);
    if (ask.id.startsWith("pot") && ask.id.endsWith("-max")) session.setAnalog(ask.part ?? "POT1", 1);
    let value = "done";
    if (ask.kind === "which-led") {
      // Look at the board like a person: report the LED that is actually lit.
      session.run(plan.timing.ledPeriodMs);
      const leds = plan.subjects.filter((s): s is Extract<SelfTestPlan["subjects"][number], { kind: "led" }> => s.kind === "led");
      const brightest = leds.reduce((best, s) => (session.partState(s.part) > session.partState(best.part) ? s : best), leds[0]);
      value = brightest === undefined || session.partState(brightest.part) <= 0.02 ? "none" : String(brightest.order);
    } else if (ask.kind === "heard-beep") {
      session.run(100);
      value = session.partState(ask.part ?? "BZ1") > 0 ? "yes" : "no";
    }
    answers[ask.id] = value;
    session.serialWrite(`${JSON.stringify({ c: "answer", id: ask.id, v: value })}\n`);
  };
  session.run(100);
  session.serialWrite('{"c":"run","test":"all"}\n');
  for (let t = 0; t < 10_000 && !lines.some((l) => l.t === "done"); t += 10) {
    session.run(10);
    for (let ask = pending.shift(); ask; ask = pending.shift()) answer(ask);
  }
  return { lines, answers };
}

// ---------- one brief ----------

type Verdicts = Record<string, string>;
interface BriefResult {
  key: string;
  brief: string;
  missionId: string;
  design: { wallS: number; toolCalls: number; toolNames: string[]; tokens: number; costUsd: number; askBacks: number; finalText: string; exit: number };
  revisions: { n: number; verdicts: Verdicts; findings: string[] }[];
  proposeAttempts: number;
  firstAllDeterministicGo?: number;
  final?: { n: number; verdicts: Verdicts; scenarios: number; passed: number; coverageOk: boolean; coverageMissing: string[]; failures: string[]; retro: { verdict: string; summary: string } };
  agents: { testAuthorCalls: number; retroCalls: number; ms: number; tokens: number; costUsd: number; errors: string[] };
  build?: { jumpers: number; steps: number; breadboard: string; fao: string; faoSummary: string };
  release: { ok: boolean; revision?: number; status?: number; error?: string };
  bench?: { verdict: string; dictionary: boolean; failed: string[] };
  fault?: { id: FaultId; verdict: string; caught: boolean; rank: number; top: string[] };
  totalWallS: number;
  error?: string;
}

const DETERMINISTIC = ["EECOM", "GUIDO", "FIDO", "FAO"];

/** GO for build → final revision numbers → virtual bench self-test → one injected wiring fault. */
async function releaseAndBench(result: BriefResult, lastN: number): Promise<void> {
  const { key, missionId } = result;
  const release = await api<MissionDetail & { error?: { code: string; message: string } }>("POST", `/api/missions/${missionId}/release`, { revision: lastN });
  const releasedN = release.json.mission?.releasedRevision;
  result.release = release.status === 200 && releasedN !== undefined ? { ok: true, revision: releasedN } : { ok: false, status: release.status, error: `${release.json.error?.code}: ${release.json.error?.message}` };
  log(key, "release:", JSON.stringify(result.release));

  const finalN = releasedN ?? lastN;
  const rev = (await api<RevisionDetail>("GET", `/api/missions/${missionId}/revisions/${finalN}`)).json;
  const reports = Object.fromEntries(rev.results.reports.map((rep) => [rep.console, rep]));
  const sim = rev.results.sim;
  result.final = {
    n: finalN,
    verdicts: Object.fromEntries(rev.results.reports.map((rep) => [rep.console, rep.verdict])),
    scenarios: rev.suite?.scenarios.length ?? 0,
    passed: sim?.scenarios.filter((s) => s.ok).length ?? 0,
    coverageOk: sim?.coverage.ok ?? false,
    coverageMissing: sim?.coverage.missing ?? [],
    failures: sim?.scenarios.filter((s) => !s.ok).map((s) => `${s.id} ${s.title}: ${s.steps.filter((st) => !st.ok).map((st) => st.message).join("; ")}`) ?? [],
    retro: { verdict: reports.RETRO?.verdict ?? "none", summary: reports.RETRO?.summary ?? "" },
  };
  result.build = {
    jumpers: rev.results.layout?.jumpers.length ?? 0,
    steps: rev.results.steps?.steps.length ?? 0,
    breadboard: rev.circuit.breadboard.profile,
    fao: reports.FAO?.verdict ?? "none",
    faoSummary: reports.FAO?.summary ?? "",
  };
  if (!result.release.ok) return;

  // Bench: the server compiles the self-test firmware for the released revision and stores its plan.
  const firmware = (await api<{ hex: string; plan: SelfTestPlan }>("POST", `/api/missions/${missionId}/bench/firmware`, { kind: "bench" })).json;
  let dictionary = false;
  for (let waited = 0; waited < 300_000; waited += 5_000) {
    const current = (await api<RevisionDetail>("GET", `/api/missions/${missionId}/revisions/${finalN}`)).json;
    if (current.results.artifacts["faults.json"]) {
      dictionary = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const good = virtualSelfTest(rev.circuit, firmware.plan, firmware.hex);
  const goodRun = (await api<BenchRunResult>("POST", `/api/missions/${missionId}/bench/runs`, { revision: finalN, kind: "selftest", plan: firmware.plan, ...good, runId: "virtual-good" })).json;
  result.bench = { verdict: goodRun.verdict, dictionary, failed: goodRun.results.filter((r) => r.status !== "pass").map((r) => `${r.test}: ${r.status} — ${r.summary}`) };
  log(key, "virtual self-test:", goodRun.verdict);

  const layout = rev.results.layout;
  if (!layout) throw new Error("released revision has no layout");
  const order: FaultId[] = rev.circuit.parts.some((p) => p.module === "button") ? ["button-leg-in-gnd-row", "led-jumpers-swapped", "led-missing"] : ["led-jumpers-swapped", "led-missing"];
  for (const id of order) {
    let applied;
    try {
      applied = applyFault({ circuit: rev.circuit, layout, fault: id });
    } catch {
      continue;
    }
    const faulty = virtualSelfTest(applied.circuit, firmware.plan, firmware.hex);
    const faultRun = (await api<BenchRunResult>("POST", `/api/missions/${missionId}/bench/runs`, { revision: finalN, kind: "selftest", plan: firmware.plan, ...faulty, runId: `virtual-${id}` })).json;
    const causes = faultRun.diagnosis.candidates.map((c) => c.cause);
    result.fault = { id, verdict: faultRun.verdict, caught: faultRun.verdict === "fail", rank: causes.indexOf(id) + 1, top: causes.slice(0, 3) };
    log(key, `fault ${id}: ${faultRun.verdict}, true cause rank ${result.fault.rank}`);
    break;
  }
}

async function runBrief(b: Brief, token: string): Promise<BriefResult> {
  const started = performance.now();
  const dir = join(OUT, b.key);
  await mkdir(join(dir, ".omp"), { recursive: true });
  const created = await api<{ id: string }>("POST", "/api/missions", { title: `E2E ${b.key}`, brief: b.brief, inventory: b.inventory, mode: "review" });
  const missionId = created.json.id;
  const result: BriefResult = {
    key: b.key,
    brief: b.brief,
    missionId,
    design: { wallS: 0, toolCalls: 0, toolNames: [], tokens: 0, costUsd: 0, askBacks: 0, finalText: "", exit: 0 },
    revisions: [],
    proposeAttempts: 0,
    agents: { testAuthorCalls: 0, retroCalls: 0, ms: 0, tokens: 0, costUsd: 0, errors: [] },
    release: { ok: false },
    totalWallS: 0,
  };
  try {
    // timeout 0: propose_design runs the test author and RETRO inline (minutes); omp's default MCP deadline is 30 s.
    await writeFile(join(dir, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { vibread: { type: "http", url: `${API}/mcp`, headers: { Authorization: `Bearer ${token}` }, timeout: 0 } } }));
    const detail = (await api<MissionDetail>("GET", `/api/missions/${missionId}`)).json;
    const system = designSystemPrompt({ mission: detail.mission, revision: null });
    await writeFile(join(dir, "design-system.txt"), system);
    const prompt = `Act under these instructions:\n<instructions>\n${system}\n</instructions>\n\nEnvironment notes (from the harness, not the user): the tools above are the "vibread" MCP tools; pass missionId "${missionId}" to every call. There is no ask_user tool here — to ask the user, end your turn with your one question as your final reply. Work only through the vibread tools.\n\nThe user says: ${b.brief}`;
    // read/write only: MCP tools are omp xd:// devices (read = schema, write = call). Without the eval tool the agent calls
    // tools directly, like Claude Code does; eval cells time out after 30 s while propose_design runs for minutes.
    const common = ["-p", "--session-dir", join(dir, "session"), "--no-title", "--no-rules", "--no-skills", "--tools", "read,write", "--model", DESIGN_MODEL, "--max-time", "30m", "--mode", "json"];
    log(b.key, "design agent started", missionId);
    let design = await run("omp", [...common, prompt], { cwd: dir, stdoutFile: join(dir, "design-1.jsonl") });
    await writeFile(join(dir, "design-1.err"), design.stderr);
    let transcript = parseOmp(design.stdout);
    let wall = design.ms;
    const merged = { toolCalls: [...transcript.toolCalls], tokens: transcript.tokens, costUsd: transcript.costUsd };
    let revisions = (await api<{ n: number }[]>("GET", `/api/missions/${missionId}/revisions`)).json;
    if (!revisions.length && design.code === 0) {
      // The agent asked back instead of designing: answer once like a person who wants it to just pick.
      result.design.askBacks = 1;
      log(b.key, "asked back:", transcript.text.slice(0, 160).replace(/\n/g, " "));
      design = await run("omp", [...common, "-c", "You decide — go with what you think is best and build it now."], { cwd: dir, stdoutFile: join(dir, "design-2.jsonl") });
      await writeFile(join(dir, "design-2.err"), design.stderr);
      transcript = parseOmp(design.stdout);
      wall += design.ms;
      merged.toolCalls.push(...transcript.toolCalls);
      merged.tokens += transcript.tokens;
      merged.costUsd += transcript.costUsd;
      revisions = (await api<{ n: number }[]>("GET", `/api/missions/${missionId}/revisions`)).json;
    }
    result.design = { ...result.design, wallS: Math.round(wall / 1000), toolCalls: merged.toolCalls.length, toolNames: merged.toolCalls, tokens: merged.tokens, costUsd: merged.costUsd, finalText: transcript.text, exit: design.code };
    log(b.key, `design done in ${result.design.wallS}s, ${revisions.length} revision(s), exit ${design.code}`);

    for (const r of revisions.sort((x, y) => x.n - y.n)) {
      const rev = (await api<RevisionDetail>("GET", `/api/missions/${missionId}/revisions/${r.n}`)).json;
      const verdicts = Object.fromEntries(rev.results.reports.map((rep) => [rep.console, rep.verdict]));
      const findings = rev.results.reports.flatMap((rep) => rep.findings.filter((f) => f.severity === "error").map((f) => `${rep.console} ${f.ruleId}: ${f.title}`));
      result.revisions.push({ n: r.n, verdicts, findings });
    }
    result.proposeAttempts = result.revisions.length;
    result.firstAllDeterministicGo = result.revisions.findIndex((r) => DETERMINISTIC.every((c) => r.verdicts[c] === "GO")) + 1 || undefined;
    const last = result.revisions.at(-1);
    if (!last) throw new Error("the design agent created no revision");

    await releaseAndBench(result, last.n);
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(b.key, "ERROR", result.error);
    return result;
  } finally {
    const mine = bridgeCalls.filter((c) => c.prompt.includes(b.brief));
    result.agents = {
      testAuthorCalls: mine.filter((c) => c.role === "test-author").length,
      retroCalls: mine.filter((c) => c.role === "retro").length,
      ms: mine.reduce((s, c) => s + c.ms, 0),
      tokens: mine.reduce((s, c) => s + c.tokens, 0),
      costUsd: mine.reduce((s, c) => s + c.costUsd, 0),
      errors: mine.filter((c) => c.error).map((c) => `${c.role}: ${c.error}`),
    };
    result.totalWallS = Math.round((performance.now() - started) / 1000);
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
}

// ---------- summary ----------

function summaryTable(results: BriefResult[]): string {
  const rows = results.map((r) => {
    const v = r.final?.verdicts ?? {};
    return `| ${r.key} | ${r.design.wallS} s | ${r.design.toolCalls} | ${r.proposeAttempts}${r.design.askBacks ? " (+1 ask-back)" : ""} | ${r.firstAllDeterministicGo ?? "—"} | ${["EECOM", "GUIDO", "FIDO", "FAO", "RETRO"].map((c) => `${c} ${v[c] ?? "—"}`).join(" · ")} | ${r.final ? `${r.final.passed}/${r.final.scenarios}${r.final.coverageOk ? "" : " cov✗"}` : "—"} | ${r.final?.retro.verdict ?? "—"} | ${r.build ? `${r.build.jumpers} / ${r.build.steps} / ${r.build.breadboard}` : "—"} | ${r.release.ok ? `r${r.release.revision}` : `✗ ${r.release.error ?? r.error ?? ""}`} | ${r.bench?.verdict ?? "—"} | ${r.fault ? `${r.fault.id}: ${r.fault.caught ? "caught" : "missed"}, rank ${r.fault.rank || "—"}` : "—"} | ${r.totalWallS} s | ${Math.round((r.design.tokens + r.agents.tokens) / 1000)}k / $${(r.design.costUsd + r.agents.costUsd).toFixed(2)} |`;
  });
  return [
    "| Brief | Design time | Tool calls | propose_design | First all-GO (EECOM/GUIDO/FIDO/FAO) | Final consoles | FIDO pass | RETRO | Jumpers / steps / board | Release | Virtual self-test | Injected fault | Total | Tokens / cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

// ---------- main ----------

await mkdir(OUT, { recursive: true });
const bridge = createServer((req, response) => void bridgeHandle(req, response).catch((e: unknown) => {
  response.writeHead(500);
  response.end(String(e));
}));
bridge.requestTimeout = 0;
bridge.headersTimeout = 0;
await new Promise<void>((resolve) => bridge.listen(BRIDGE_PORT, "127.0.0.1", resolve));
log(`model bridge on :${BRIDGE_PORT}`);

const serverLog = join(OUT, "server.log");
const server = spawn("npm", ["start"], {
  cwd: REPO,
  detached: true,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR, ANTHROPIC_API_KEY: "omp-bridge", ANTHROPIC_BASE_URL: `http://127.0.0.1:${BRIDGE_PORT}/v1` },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
server.stdout?.on("data", (d: Buffer) => (serverOut += d.toString()));
server.stderr?.on("data", (d: Buffer) => (serverOut += d.toString()));
const stopServer = async () => {
  await writeFile(serverLog, serverOut);
  if (server.pid) process.kill(-server.pid, "SIGTERM");
  bridge.close();
};
try {
  for (let i = 0; ; i++) {
    const up = await fetch(`${API}/api/missions`).then((r) => r.ok).catch(() => false);
    if (up) break;
    if (i > 120) throw new Error(`ViBread did not start on :${PORT}; see ${serverLog}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  log(`ViBread on :${PORT} (DATA_DIR ${DATA_DIR})`);
  const token = (await api<{ token: string }>("POST", "/api/connections/tokens", { scopes: ["circuits:read", "circuits:write"], ttlMinutes: 240 })).json.token;

  const results: BriefResult[] = [];
  for (const key of RESUME) {
    const file = join(OUT, key, "result.json");
    const result = JSON.parse(await readFile(file, "utf8")) as BriefResult;
    const started = performance.now();
    delete result.error;
    try {
      await releaseAndBench(result, result.revisions.at(-1)!.n);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      log(key, "ERROR", result.error);
    }
    result.totalWallS += Math.round((performance.now() - started) / 1000);
    await writeFile(file, JSON.stringify(result, null, 2));
    results.push(result);
  }
  const queue = BRIEFS.filter((b) => (!ONLY.length || ONLY.includes(b.key)) && !RESUME.includes(b.key));
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) results.push(await runBrief(b, token));
    }),
  );
  results.sort((x, y) => BRIEFS.findIndex((b) => b.key === x.key) - BRIEFS.findIndex((b) => b.key === y.key));
  // The table covers every brief with a result in <out> (earlier and resumed runs included).
  const all: BriefResult[] = [];
  for (const b of BRIEFS) {
    const stored = await readFile(join(OUT, b.key, "result.json"), "utf8").catch(() => undefined);
    if (stored) all.push(JSON.parse(stored) as BriefResult);
  }
  const table = summaryTable(all);
  await writeFile(join(OUT, "summary.md"), `${table}\n`);
  await writeFile(join(OUT, `bridge-calls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(bridgeCalls.map(({ prompt: _p, ...c }) => c), null, 2));
  log(`${results.length} brief(s) this run`);
} finally {
  await stopServer();
}
