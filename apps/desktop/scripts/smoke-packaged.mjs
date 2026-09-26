// Launches the packaged app in smoke mode (VIBREAD_SMOKE=1, see src/smoke.ts) the way a user would get it:
//   Linux   → the AppImage under xvfb-run (APPIMAGE_EXTRACT_AND_RUN: CI containers have no /dev/fuse)
//   Windows → silent-installs the NSIS installer into a temp dir, runs the installed ViBread.exe
//   macOS   → the .app from the dmg/zip build directory
// Exits with the app's exit code; smoke.json + screenshots land in VIBREAD_SMOKE_DIR.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "release");
const find = (pattern) => readdirSync(RELEASE).find((name) => pattern.test(name)) ?? fail(`no ${pattern} in ${RELEASE}`);
const env = { ...process.env, VIBREAD_SMOKE: "1" };
if (!env.VIBREAD_USER_DATA) fail("set VIBREAD_USER_DATA to a throwaway directory");

let command;
let args = [];
if (process.platform === "linux") {
  command = "xvfb-run";
  args = ["-a", "-s", "-screen 0 1600x1000x24", join(RELEASE, find(/\.AppImage$/))];
  env.APPIMAGE_EXTRACT_AND_RUN = "1";
} else if (process.platform === "win32") {
  const installDir = join(tmpdir(), "ViBread-smoke-install");
  const installer = join(RELEASE, find(/\.exe$/));
  const started = Date.now();
  const install = spawnSync(installer, ["/S", `/D=${installDir}`], { stdio: "inherit" });
  if (install.status !== 0) fail(`installer exited ${install.status}`);
  console.log(`installed in ${Math.round((Date.now() - started) / 1000)} s → ${installDir}`);
  command = join(installDir, "ViBread.exe");
} else if (process.platform === "darwin") {
  const dir = readdirSync(RELEASE).find((name) => name.startsWith("mac") && existsSync(join(RELEASE, name, "ViBread.app"))) ?? fail("no ViBread.app");
  command = join(RELEASE, dir, "ViBread.app", "Contents", "MacOS", "ViBread");
} else {
  fail(`unsupported platform ${process.platform}`);
}

console.log(`smoke: ${command} ${args.join(" ")}`);
const started = Date.now();
const child = spawn(command, args, { env, stdio: "inherit" });
const timer = setTimeout(() => {
  console.error("smoke: timed out after 25 minutes");
  child.kill("SIGKILL");
}, 25 * 60_000);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  console.log(`smoke: app exited ${signal ?? code} after ${Math.round((Date.now() - started) / 1000)} s`);
  const report = join(env.VIBREAD_SMOKE_DIR ?? join(env.VIBREAD_USER_DATA, "smoke"), "smoke.json");
  if (existsSync(report)) console.log(readFileSync(report, "utf8"));
  else console.error(`smoke: ${report} was not written`);
  process.exit(code === 0 && existsSync(report) && JSON.parse(readFileSync(report, "utf8")).ok ? 0 : 1);
});

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}
