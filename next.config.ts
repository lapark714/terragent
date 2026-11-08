import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node at runtime instead of bundled: agentmail's ESM wrapper imports an optional
  // @x402/fetch, and PGlite ships WASM + data files that bundlers mangle.
  serverExternalPackages: ["agentmail", "@electric-sql/pglite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
