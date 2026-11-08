/**
 * Environment access. Lazy and typed: nothing throws at import time (so `next build` works
 * without secrets); call `requireEnv("X")` where a value is truly needed.
 * Names only live in .env.example — never values.
 */
const ALIASES: Record<string, string[]> = {
  // The Naïve CLI reads either name; our .env uses VETTA_API_KEY (spec §4.1).
  NAIVE_API_KEY: ["NAIVE_API_KEY", "VETTA_API_KEY"],
  NAIVE_BASE_URL: ["NAIVE_BASE_URL", "VETTA_BASE_URL"],
};

export function env(name: string): string | undefined {
  for (const n of ALIASES[name] ?? [name]) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env(name) ?? "");
}

export function envNumber(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && env(name) !== undefined ? v : fallback;
}

/** Public origin of the deployed app, no trailing slash. Agents, webhooks and report links use it. */
export function publicBaseUrl(): string {
  const v = env("PUBLIC_BASE_URL") ?? (env("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${env("VERCEL_PROJECT_PRODUCTION_URL")}` : undefined);
  return (v ?? "http://localhost:3000").replace(/\/+$/, "");
}

export const isProduction = () => env("VERCEL_ENV") === "production";

/**
 * Offline mode for local UI work (npm run dev:local): no Naïve sessions, no AgentMail sends, no Monid runs.
 * On whenever TERRAGENT_OFFLINE is truthy or the demo database is in use, so a local portal submit can never
 * wake a real agent or email a real person. Never on in production.
 */
export function isOffline(): boolean {
  if (env("VERCEL_ENV") === "production") return false;
  return envFlag("TERRAGENT_OFFLINE") || env("TERRAGENT_DB") === "local";
}
