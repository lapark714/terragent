import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "node_modules/**", ".claude/**"],
    environment: "node",
    // Never let unit tests reach production Neon or real services.
    env: { TERRAGENT_DB: "memory", DATABASE_URL: "" },
    testTimeout: 30_000,
  },
});
