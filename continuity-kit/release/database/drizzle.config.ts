import { defineConfig } from "drizzle-kit";

// File generation only; no remote database URL or credential is configured.
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
  breakpoints: true,
});
