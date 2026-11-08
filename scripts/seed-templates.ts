/**
 * Upsert the draft outreach + follow-up templates (src/lib/email/template-library.ts). Drafts only: a founder
 * approves each in the dashboard before agents may send it; approved/retired templates are never modified.
 *   TERRAGENT_DB=memory npx tsx scripts/seed-templates.ts   # try it without touching a real database
 *   npx tsx scripts/seed-templates.ts                       # DATABASE_URL (Neon) or local PGlite
 */
import "dotenv/config";
import { createDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";
import { seedTemplates } from "../src/lib/email/template-library";

const db = await createDb();
if (process.env.TERRAGENT_DB === "memory") await migrate(db);
for (const r of await seedTemplates(db)) console.log(`  ${r.action.padEnd(8)} ${r.playbook}/${r.version}`);
console.log(`[seed-templates] done (${db.kind})`);
await db.close();
