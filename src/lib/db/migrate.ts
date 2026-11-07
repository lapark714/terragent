/**
 * Minimal migration runner: applies db/migrations/*.sql in filename order, once each.
 * Statements are split on top-level semicolons because Neon's HTTP driver runs one
 * statement per call. Keep migrations free of $$-quoted function bodies (or extend the splitter).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./client";

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!inQuote && trimmed.startsWith("--")) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'") inQuote = !inQuote;
      if (!inQuote && ch === "-" && line[i + 1] === "-") break; // trailing comment
      if (!inQuote && ch === ";") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function migrate(db: Db, dir = path.join(process.cwd(), "db", "migrations")) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = splitSql(await readFile(path.join(dir, file), "utf8"));
    for (const stmt of statements) await db.query(stmt);
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    ran.push(file);
  }
  return ran;
}
