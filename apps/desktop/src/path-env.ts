import { execFile } from "node:child_process";

// Where Homebrew, distro packages and ngspice live; Finder/desktop launches often get a PATH without them.
const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * PATH for the server child: the user's own PATH first (so `omp`, ngspice etc. resolve exactly as in their terminal),
 * then the standard system directories, then the usual per-user install locations (bun, npm-global, pipx/local).
 * Duplicates are dropped, first occurrence wins.
 */
export function serverPath(userPath: string | undefined, home: string, platform: NodeJS.Platform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const sep = platform === "win32" ? "\\" : "/";
  const userDirs = [".bun/bin", ".npm-global/bin", ".local/bin"].map((dir) => [home, ...dir.split("/")].join(sep));
  const parts = [...(userPath ?? "").split(delimiter), ...(platform === "win32" ? [] : SYSTEM_DIRS), ...userDirs];
  const seen = new Set<string>();
  return parts.filter((part) => part && !seen.has(part) && seen.add(part)).join(delimiter);
}

/**
 * The PATH a login shell would give the user (macOS/Linux GUI launches don't read ~/.zshrc, ~/.bashrc, nvm, etc.).
 * Runs `$SHELL -ilc` once with a 3 s timeout; falls back to the inherited PATH. Windows GUI apps already inherit it.
 */
export async function loginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return process.env.Path ?? process.env.PATH;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const marker = "__VIBREAD_PATH__";
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  execFile(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], { timeout: 3_000, encoding: "utf8" }, (_error, stdout) => {
    // Interactive shells may print banners; take only what sits between the markers.
    const match = new RegExp(`${marker}(.*?)${marker}`, "s").exec(stdout ?? "");
    resolve(match?.[1] || process.env.PATH);
  });
  return promise;
}
