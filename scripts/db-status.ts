/** Usage: npm run db:status — which database, which migrations, row counts. Prints no secrets. */
import "dotenv/config";
import { createDb } from "../src/lib/db/client";

const db = await createDb();
const where = db.kind === "neon"
  ? `neon (${new URL(process.env.DATABASE_URL!).hostname.includes("-pooler") ? "pooled" : "direct"} connection)`
  : "pglite (local)";
const migrations = await db.query<{ name: string }>(
  "SELECT name FROM schema_migrations ORDER BY 1",
).catch(() => [] as { name: string }[]);
const [version] = await db.query<{ v: string }>("SELECT split_part(version(), ' ', 2) AS v");
console.log(`[db] ${where}, Postgres ${version.v}`);
console.log(`[db] migrations: ${migrations.map((m) => m.name).join(", ") || "none"}`);
if (migrations.length) {
  const counts = await db.query<Record<string, string | number>>(
    `SELECT (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM reports) AS reports,
            (SELECT count(*) FROM signals) AS signals, (SELECT count(*) FROM prospects) AS prospects,
            (SELECT count(*) FROM earth_index) AS earth_index, (SELECT count(*) FROM providers) AS providers`,
  );
  console.log("[db] rows:", Object.entries(counts[0]).map(([k, v]) => `${k}=${v}`).join(" "));
}
await db.close();
