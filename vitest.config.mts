import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
