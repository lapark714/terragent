/**
 * Usage: tsx scripts/seed-providers.ts [--yes]
 * Upserts the provider & data-type registry (db/seeds/providers.ts). Local PGlite unless DATABASE_URL is set;
 * writing to Neon (production) needs --yes. Dry run on memory: TERRAGENT_DB=memory tsx scripts/seed-providers.ts
 */
import "dotenv/config";
import { createDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";
import { PROVIDERS, seedProviders } from "../db/seeds/providers";

const db = await createDb();
if (db.kind === "neon" && !process.argv.includes("--yes")) {
  console.log(`[seed-providers] target is Neon (production). Re-run with --yes to upsert ${PROVIDERS.length} provider rows.`);
  process.exit(1);
}
await migrate(db);
const n = await seedProviders(db);
const [{ free }] = await db.query<{ free: number }>("SELECT count(*)::int AS free FROM providers WHERE is_free");
console.log(`[seed-providers] ${db.kind}: upserted ${n} providers (${free} free).`);
await db.close();
