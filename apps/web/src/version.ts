export type RuntimeKind = "desktop" | "server";

export interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
  runtime?: RuntimeKind;
}
const bundleVersion = typeof __VIBREAD_VERSION__ === "undefined" ? "0.1.0-dev" : __VIBREAD_VERSION__;
const bundleCommit = typeof __VIBREAD_COMMIT__ === "undefined" ? "unknown" : __VIBREAD_COMMIT__;
const bundleBuiltAt = typeof __VIBREAD_BUILT_AT__ === "undefined" ? new Date().toISOString() : __VIBREAD_BUILT_AT__;

export const WEB_VERSION: VersionInfo = {
  version: bundleVersion,
  commit: bundleCommit,
  builtAt: bundleBuiltAt,
};

export function formatBuiltAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
