// VIBREAD_SMOKE=1: end-to-end self-check of a packaged build (used by CI and for local verification).
// Asserts the renderer is ViBread with Web Serial, the three golden missions exist and their firmware compiled with the
// toolchain installed into userData, captures Home / mission / bench screenshots, writes smoke.json, exits 0 or 1.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { DesktopPaths } from "./runtime.js";
import type { SerialState } from "./serial.js";
import type { ServerInfo } from "./server.js";
import type { SetupStep } from "./setup.js";

export interface SmokeTimings {
  launchedAt: number;
  firstRunMs?: number;
  toolchainMs?: number;
  seedMs?: number;
  serverStartMs?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

// arduino-cli may report Windows paths with other separators or drive-letter case.
const normalize = (path: string) => path.replaceAll("\\", "/").toLowerCase();

const GOLDEN_TITLES = ["Moon-Phase Lamp", "Knob Night-Light", "Launch Control"];

function outputDir(paths: DesktopPaths): string {
  const dir = process.env.VIBREAD_SMOKE_DIR ?? join(paths.userData, "smoke");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runSmoke(input: { window: BrowserWindow; info: ServerInfo; paths: DesktopPaths; serial: SerialState; timings: SmokeTimings; setupRan: SetupStep[] }): Promise<{ ok: boolean }> {
  const { window, info, paths, serial, timings } = input;
  const dir = outputDir(paths);
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const web = window.webContents;

  const settle = async (predicate: string, label: string) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (await web.executeJavaScript(predicate).catch(() => false)) {
        await sleep(2_500); // let fonts, SVG artifacts and queries finish painting
        return true;
      }
      await sleep(250);
    }
    check(`${label} rendered`, false, `timed out waiting for ${predicate}`);
    return false;
  };
  const shot = async (name: string) => {
    const file = join(dir, `${name}.png`);
    writeFileSync(file, (await web.capturePage()).toPNG());
    screenshots.push(file);
  };

  try {
    await settle(`document.title.includes("ViBread") && document.querySelector("#root")?.childElementCount > 0`, "Home");
    const title = await web.executeJavaScript("document.title");
    check("page title is ViBread's", typeof title === "string" && title.includes("ViBread"), String(title));
    const serialApi = await web.executeJavaScript(`'serial' in navigator && typeof navigator.serial.requestPort === "function"`);
    check("'serial' in navigator", serialApi === true, String(serialApi));
    check("select-serial-port handler installed", serial.handlerInstalled, String(serial.handlerInstalled));
    const secure = await web.executeJavaScript("window.isSecureContext");
    check("renderer is a secure context", secure === true, `${info.localUrl} isSecureContext=${secure}`);
    await shot("home");

    const missions = (await (await fetch(`${info.localUrl}/api/missions`)).json()) as { id: string; title: string }[];
    const golden = GOLDEN_TITLES.map((wanted) => missions.find((mission) => mission.title === wanted));
    check("GET /api/missions lists the 3 seeded missions", golden.every(Boolean), missions.map((m) => m.title).join(", "));

    const compiled: { title: string; ok: boolean; fqbn?: string; flashBytes?: number; toolchainPath: boolean }[] = [];
    for (const mission of golden) {
      if (!mission) continue;
      const revision = (await (await fetch(`${info.localUrl}/api/missions/${mission.id}/revisions/1`)).json()) as {
        results?: { compile?: { ok: boolean; fqbn: string; sizes?: { flashBytes: number }; diagnostics?: { file?: string }[] } };
      };
      const compile = revision.results?.compile;
      compiled.push({
        title: mission.title,
        ok: compile?.ok === true,
        fqbn: compile?.fqbn,
        flashBytes: compile?.sizes?.flashBytes,
        // Core warnings point into the AVR core, proving arduino-cli ran from <userData>/toolchain.
        toolchainPath: (compile?.diagnostics ?? []).some((d) => d.file !== undefined && normalize(d.file).startsWith(normalize(paths.toolchain))),
      });
    }
    check("seeded firmware compiled", compiled.length === 3 && compiled.every((c) => c.ok), JSON.stringify(compiled));
    check("compiled with the downloaded toolchain", compiled.some((c) => c.toolchainPath), paths.toolchain);

    const first = golden[0];
    if (first) {
      await web.loadURL(`${info.localUrl}/m/${first.id}`);
      if (await settle(`document.querySelector("#root")?.innerText.includes(${JSON.stringify(first.title)})`, "Mission workspace")) await shot("mission");
      await web.loadURL(`${info.localUrl}/m/${first.id}/bench`);
      if (await settle(`/bench|arduino|connect/i.test(document.querySelector("#root")?.innerText ?? "")`, "Bench")) await shot("bench");
      const benchSerial = await web.executeJavaScript(`'serial' in navigator`);
      check("bench page has Web Serial", benchSerial === true, String(benchSerial));
    }
  } catch (error) {
    check("smoke run", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  const report = {
    ok,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    serverUrl: info.localUrl,
    publicUrl: info.publicUrl,
    userData: paths.userData,
    setupRan: input.setupRan,
    timings: { ...timings, totalMs: Date.now() - timings.launchedAt },
    checks,
    screenshots,
  };
  writeFileSync(join(dir, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`VIBREAD_SMOKE ${ok ? "PASS" : "FAIL"} ${join(dir, "smoke.json")}`);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
  return { ok };
}

export async function writeSmokeFailure(paths: DesktopPaths | undefined, error: Error, timings: SmokeTimings): Promise<void> {
  const dir = paths ? outputDir(paths) : (process.env.VIBREAD_SMOKE_DIR ?? process.cwd());
  mkdirSync(dir, { recursive: true });
  const report = { ok: false, platform: process.platform, arch: process.arch, error: error.stack ?? error.message, timings: { ...timings, totalMs: Date.now() - timings.launchedAt } };
  writeFileSync(join(dir, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`VIBREAD_SMOKE FAIL ${error.message}`);
}
