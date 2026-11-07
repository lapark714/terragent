import { defineConfig } from "vitest/config";
import path from "node:path";

// Live tests hit real services (Planetary Computer, feeds, Naïve, AgentMail). Run: npm run test:live
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.live.test.ts", "scripts/**/*.live.test.ts"], environment: "node", testTimeout: 180_000, setupFiles: ["dotenv/config"] },
});
