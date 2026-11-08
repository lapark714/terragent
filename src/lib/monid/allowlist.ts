/**
 * The only Monid endpoints our code will pay for (docs/platform/monid.md TL;DR picks). Input locations,
 * types and prices were read with POST /v1/inspect on 2026-11-07. Everything else is refused before any call.
 */
import type { MonidInput } from "./types";

export interface AllowedEndpoint {
  provider: string;
  endpoint: string;
  /** Where a flat input object goes. */
  location: "queryParams" | "body";
  use: string;
  /** The param that sets how many billed results come back, and our ceiling for it. */
  results?: { param: string; max: number };
  /** The provider takes every param as a string (kadec0). */
  stringParams?: boolean;
}

export const MONID_ALLOWLIST: readonly AllowedEndpoint[] = [
  { provider: "akta", endpoint: "/v1/news", location: "queryParams", results: { param: "limit", max: 10 },
    use: "news and business events by company website/uuid or topic ($0.005 + $0.0005/article)" },
  { provider: "akta", endpoint: "/v1/company/search", location: "queryParams",
    use: "resolve a company name to its Akta uuid and website (free)" },
  { provider: "apollo", endpoint: "/mixed_people/api_search", location: "queryParams", results: { param: "per_page", max: 10 },
    use: "find decision makers at a company by title/domain (free; previews only, no emails)" },
  { provider: "hunterio", endpoint: "/email-finder", location: "queryParams",
    use: "verified WORK email for a named person at a company domain ($0.0245, only charged when found)" },
  { provider: "zillow", endpoint: "/get_zestimate", location: "queryParams",
    use: "property value context for a report, by zpid ($0.03)" },
  { provider: "api.kadec0.xyz", endpoint: "/v1/weather", location: "queryParams", stringParams: true,
    use: "current weather + up to 16-day forecast for lat/lng ($0.01)" },
  { provider: "api.kadec0.xyz", endpoint: "/v1/geocode", location: "queryParams", stringParams: true,
    use: "paid geocoding fallback, q=address ($0.02)" },
];

export function findAllowed(provider: string, endpoint: string): AllowedEndpoint | undefined {
  return MONID_ALLOWLIST.find((e) => e.provider === provider && e.endpoint === endpoint);
}

const LOCATIONS = ["body", "queryParams", "pathParams"] as const;

/**
 * Accepts either Monid's composite input ({ queryParams, body, pathParams }) or a flat object (placed at
 * the endpoint's location), clamps the result-count param to our ceiling, and stringifies when required.
 * Returns the input to send and the number of billed results to budget for.
 */
export function normalizeInput(entry: AllowedEndpoint, raw: Record<string, unknown>): { input: MonidInput; results: number } {
  const keys = Object.keys(raw);
  const composite = keys.length > 0 && keys.every((k) => (LOCATIONS as readonly string[]).includes(k));
  const input: MonidInput = {};
  if (composite) {
    for (const loc of LOCATIONS) if (raw[loc] && typeof raw[loc] === "object") input[loc] = { ...(raw[loc] as Record<string, unknown>) };
  } else {
    input[entry.location] = { ...raw };
  }
  let results = 1;
  if (entry.results) {
    const target = (input[entry.location] ??= {});
    const asked = Number(target[entry.results.param]);
    results = Number.isInteger(asked) && asked > 0 ? Math.min(asked, entry.results.max) : entry.results.max;
    target[entry.results.param] = results;
  }
  if (entry.stringParams) {
    for (const loc of LOCATIONS) {
      for (const [k, v] of Object.entries(input[loc] ?? {})) {
        if (typeof v === "number" || typeof v === "boolean") input[loc]![k] = String(v);
      }
    }
  }
  return { input, results };
}
