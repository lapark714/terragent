/** Test fixtures for the outbound services: a migrated in-memory DB and small row seeders. Not used at runtime. */
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";

export async function freshDb(): Promise<Db> {
  const db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  return db;
}

const TABLES = [
  "signals", "prospects", "requests", "reports", "templates", "messages", "monitors", "events", "decisions",
  "playbook_allocations", "settings", "spend", "revenue", "quotes", "earth_index", "market_prices", "suppression",
];

export async function reset(db: Db) {
  await db.query(`TRUNCATE ${TABLES.join(", ")}`);
}

/** Objects and arrays of objects go in as JSON; primitive arrays stay Postgres arrays (text[]). */
export async function insert(db: Db, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const values = keys.map((k) => {
    const v = row[k];
    const isJson = v !== null && typeof v === "object" && !(v instanceof Date) && (!Array.isArray(v) || v.some((x) => typeof x === "object"));
    return isJson ? JSON.stringify(v) : v;
  });
  await db.query(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, values);
}

let n = 0;
const id = (prefix: string) => `${prefix}_t${++n}`;

export async function seedSignal(db: Db, over: Record<string, unknown> = {}) {
  const row = { id: id("sig"), playbook: "disasters", feed: "nws", external_id: id("ext"), title: "Flood Warning for Maricopa, AZ", ...over };
  await insert(db, "signals", row);
  return row.id as string;
}

export async function seedProspect(db: Db, over: Record<string, unknown> = {}) {
  const row = {
    id: id("pro"), playbook: "disasters", company: `Acme ${n}`, domain: `acme${n}.com`, contact_email: `ops@acme${n}.com`,
    contact_name: "Dana", asset_description: "Warehouse on 5th St", asset_lat: 33.45, asset_lon: -111.94, score_total: 0.5,
    status: "matched", ...over,
  };
  await insert(db, "prospects", row);
  return row.id as string;
}

export async function seedRequest(db: Db, over: Record<string, unknown> = {}) {
  const row = { id: id("req"), source: "signal", playbook: "disasters", question: "Did it flood?", is_free_sample: true, priority: "background", ...over };
  await insert(db, "requests", row);
  return row.id as string;
}

export async function seedReport(db: Db, requestId: string, over: Record<string, unknown> = {}) {
  const row = {
    id: id("rpt"), request_id: requestId, title: "Flood check", answer: "Standing water covers the north lot. The roof looks intact.",
    confidence: "medium", limitations: "10 m resolution", verifier_status: "pass", public_token: id("tok"),
    images: [{ role: "after", url: "https://img.test/after.png", caption: "After", date: "2026-11-06", source: "Sentinel-2" }],
    measurements: [{ metric: "mndwi_delta", value: 0.31, unit: null, before: 0.01, after: 0.32, note: null }],
    sources: [{ name: "Sentinel-2 L2A", collection: "sentinel-2-l2a", item_id: "S2B_X", datetime: "2026-11-06", url: null, license: "CC-BY" }],
    ...over,
  };
  await insert(db, "reports", row);
  return row.id as string;
}

export async function seedTemplate(db: Db, over: Record<string, unknown> = {}) {
  const row = {
    id: id("tpl"), playbook: "disasters", version: id("v"), kind: "outreach", status: "approved", approved_at: new Date(),
    subject: "Satellite check of {{asset}}", body: "Hi {{contact_name|there}}, {{finding}} {{report_url}} ({{price}})", ...over,
  };
  await insert(db, "templates", row);
  return row.id as string;
}

/** A prospect with a verified free sample, ready for a first touch. */
export async function seedReadyProspect(db: Db, over: Record<string, unknown> = {}) {
  const signalId = await seedSignal(db);
  const requestId = await seedRequest(db);
  await seedReport(db, requestId);
  const prospectId = await seedProspect(db, { signal_id: signalId, sample_request_id: requestId, status: "sample_requested", ...over });
  await db.query("UPDATE requests SET prospect_id = $1 WHERE id = $2", [prospectId, requestId]);
  return { prospectId, requestId, signalId };
}
