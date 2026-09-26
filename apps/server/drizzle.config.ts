import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const prefix = existsSync(join(process.cwd(), "apps/server/src/db/schema.ts")) ? "apps/server" : ".";

export default defineConfig({
  schema: `${prefix}/src/db/schema.ts`,
  out: `${prefix}/drizzle`,
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_URL ?? `${prefix}/data/vibread.sqlite` },
  strict: true,
  verbose: true,
});
