// Compiles every golden sketch for the Uno with the repo toolchain and writes fixtures/hex/<key>.uno.hex.
// Run: npx tsx fixtures/scripts/build-hex.ts   (after `npm run setup:toolchain`)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_PROFILES } from "@vibread/core";
import { GOLDEN } from "../src/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(root, ".toolchain/bin/arduino-cli");
const config = join(root, ".toolchain/arduino/arduino-cli.yaml");
const outDir = fileURLToPath(new URL("../hex", import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const design of GOLDEN) {
  const work = mkdtempSync(join(tmpdir(), `vb-${design.key}-`));
  const sketchDir = join(work, design.key);
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, `${design.key}.ino`), design.circuit.sketch.source);
  const build = join(work, "build");
  const fqbn = BOARD_PROFILES[design.circuit.board.profile].fqbn;
  execFileSync(cli, ["--config-file", config, "compile", "--fqbn", fqbn, "--warnings", "all", "--output-dir", build, sketchDir], { stdio: "inherit" });
  copyFileSync(join(build, `${design.key}.ino.hex`), join(outDir, `${design.key}.uno.hex`));
  rmSync(work, { recursive: true, force: true });
  console.log(`wrote ${design.key}.uno.hex`);
}
