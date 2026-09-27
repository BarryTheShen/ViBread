import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const DEFAULT_APP_VERSION = "0.1.0-dev";

export interface BuildVersion {
  version: string;
  commit: string;
  builtAt: string;
}

type GeneratedVersion = Partial<BuildVersion>;

function generatedVersion(): GeneratedVersion | undefined {
  try {
    return JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8")) as GeneratedVersion;
  } catch {
    return undefined;
  }
}

export function shortCommit(value: string | undefined): string | undefined {
  const commit = value?.trim();
  return commit ? commit.slice(0, 7) : undefined;
}

function gitCommit(cwd = process.cwd()): string | undefined {
  try {
    return shortCommit(execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

export function resolveBuildVersion(env: NodeJS.ProcessEnv = process.env): BuildVersion {
  const generated = generatedVersion();
  return {
    version: env.APP_VERSION?.trim() || generated?.version?.trim() || DEFAULT_APP_VERSION,
    commit: shortCommit(env.GITHUB_SHA) || shortCommit(generated?.commit) || gitCommit() || "unknown",
    builtAt: env.VIBREAD_BUILT_AT?.trim() || generated?.builtAt?.trim() || new Date().toISOString(),
  };
}

export const BUILD_VERSION = resolveBuildVersion();
export const APP_VERSION = BUILD_VERSION.version;
