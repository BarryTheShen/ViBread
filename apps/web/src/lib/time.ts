import { useEffect, useState } from "react";

/** Current time, re-rendered every `intervalMs` (for expiry countdowns and "5 min ago" labels). */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "Expires in 9 min" / "Expired" for approval chips. */
export function expiryLabel(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "No expiry";
  if (ms <= 0) return "Expired";
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 120 ? `Expires in ${Math.round(minutes / 60)} h` : `Expires in ${minutes} min`;
}

/** "just now", "5 min ago", "3 h ago", or a date for older items. */
export function agoLabel(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (Number.isNaN(ms)) return "";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString();
}
