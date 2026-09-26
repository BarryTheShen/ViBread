#!/usr/bin/env node
import { existsSync, readFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const dataFlag = args.indexOf("--data-dir");
const dataDir = dataFlag >= 0 ? resolve(args[dataFlag + 1] ?? "./data") : resolve(process.env.DATA_DIR ?? "./data");
const mission = args.find((arg, index) => !arg.startsWith("--") && index !== dataFlag + 1);
const path = mission ? join(dataDir, "logs", "missions", `${mission.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`) : join(dataDir, "logs", "server.jsonl");
let offset = 0;

function printChunk(): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const chunk = text.slice(offset);
  offset = text.length;
  for (const line of chunk.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      const data = entry.data && typeof entry.data === "object" ? ` ${JSON.stringify(entry.data)}` : "";
      console.log(`${entry.ts ?? ""} [${entry.level ?? "info"}] ${entry.area ?? ""} ${entry.message ?? ""}${data}`);
    } catch {
      console.log(line);
    }
  }
}

printChunk();
if (follow) watch(join(dataDir, "logs"), { recursive: true }, printChunk);
