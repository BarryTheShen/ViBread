import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: resolve(root, "src/db/schema.ts"),
  out: resolve(root, "drizzle"),
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_URL ?? resolve(root, "data/vibread.sqlite") },
  strict: true,
  verbose: true,
});
