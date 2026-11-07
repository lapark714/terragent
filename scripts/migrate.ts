/** Usage: npm run db:migrate   (uses DATABASE_URL if set, else local PGlite in .pglite/) */
import "dotenv/config";
import { createDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";

const db = await createDb();
const ran = await migrate(db);
console.log(`[migrate] ${db.kind}: ${ran.length ? "applied " + ran.join(", ") : "up to date"}`);
await db.close();
