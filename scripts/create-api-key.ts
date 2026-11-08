/**
 * Mint a public API key. Prints the raw key ONCE; only its sha256 is stored.
 * Usage: tsx scripts/create-api-key.ts <owner> [--rate <requests per hour>]
 * Targets Neon when DATABASE_URL is set, else local PGlite (TERRAGENT_DB=memory for a dry run).
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { createApiKey } from "../src/lib/api-keys";
import { CAPS } from "../src/lib/config";
import { getDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";

function usage(): never {
  console.error("Usage: tsx scripts/create-api-key.ts <owner> [--rate <requests per hour>]");
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({ options: { rate: { type: "string" } }, allowPositionals: true });
} catch {
  usage();
}
const owner = parsed.positionals[0]?.trim();
const rate = parsed.values.rate === undefined ? CAPS.apiRequestsPerHourDefault : Number(parsed.values.rate);
if (!owner || parsed.positionals.length > 1 || !Number.isInteger(rate) || rate < 1) usage();

const db = await getDb();
// A local PGlite database may be fresh; Neon is migrated separately with npm run db:migrate.
if (db.kind === "pglite") await migrate(db);
const created = await createApiKey(owner, rate);
console.log(`[api-key] ${db.kind}: created ${created.id} for "${owner}" (${rate} requests/hour)`);
console.log("[api-key] Copy this key now; it is not stored and cannot be shown again:");
console.log(created.key);
await db.close();
