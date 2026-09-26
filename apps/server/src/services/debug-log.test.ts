import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileDebugLog } from "./debug-log.js";

describe("debug log", () => {
  it("redacts secrets and truncates data", () => {
    const dir = `/tmp/vb-debug-${randomUUID()}`;
    try {
      const debug = new FileDebugLog(dir);
      debug.event("m1", "error", "failed", { authorization: "Bearer secret", token: "tok", message: "x".repeat(5000) });
      const line = readFileSync(`${dir}/logs/missions/m1.jsonl`, "utf8");
      expect(line).not.toContain("Bearer secret");
      expect(line).toContain("[REDACTED]");
      expect(line).toContain("[truncated]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
