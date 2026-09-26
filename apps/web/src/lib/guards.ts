/** The web app's one canonical object guard for server-sent JSON; fields stay `unknown` until checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
