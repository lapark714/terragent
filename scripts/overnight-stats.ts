/**
 * The outreach funnel since a given time: who the agents found, who was contacted, who replied, what they'd pay.
 *   npx tsx scripts/overnight-stats.ts [--since 2026-11-08T10:30:00Z]   (default: the last 12 hours)
 */
import "dotenv/config";
import { getDb } from "../src/lib/db/client";
import { getNaive } from "../src/lib/naive/client";

const argv = process.argv.slice(2);
const flag = argv.indexOf("--since");
const since = flag >= 0 ? new Date(argv[flag + 1]) : new Date(Date.now() - 12 * 3_600_000);
const db = await getDb();
const rows = (sql: string) => db.query<Record<string, unknown>>(sql, [since]);
const one = async (sql: string) => Number((await rows(sql))[0]?.n ?? 0);

console.log(`Outreach since ${since.toISOString()}\n`);
console.log("Signals found:          ", await one("SELECT count(*)::int n FROM signals WHERE created_at >= $1"));
console.log("Businesses found:       ", await one("SELECT count(*)::int n FROM prospects WHERE created_at >= $1"));
console.log("Free samples started:   ", await one("SELECT count(*)::int n FROM requests WHERE is_free_sample AND created_at >= $1"));
console.log("Contacted (form):       ", await one("SELECT count(*)::int n FROM messages WHERE direction='outbound' AND prospect_id IS NOT NULL AND channel='contact_form' AND status='sent' AND created_at >= $1"));
console.log("Contacted (email):      ", await one("SELECT count(*)::int n FROM messages WHERE direction='outbound' AND prospect_id IS NOT NULL AND channel<>'contact_form' AND status='sent' AND created_at >= $1"));
console.log("Replies:                ", await one("SELECT count(*)::int n FROM messages WHERE direction='inbound' AND prospect_id IS NOT NULL AND created_at >= $1"));
console.log("Opt-outs:               ", await one("SELECT count(*)::int n FROM prospects WHERE status='opted_out' AND updated_at >= $1"));

console.log("\nBusinesses by playbook and status");
console.table(await rows("SELECT playbook, status, count(*)::int AS n FROM prospects WHERE created_at >= $1 GROUP BY 1,2 ORDER BY 1,3 DESC"));

console.log("Why contacts didn't go out");
console.table(await rows("SELECT left(coalesce(blocked_reason, status), 70) AS reason, count(*)::int AS n FROM messages WHERE direction='outbound' AND prospect_id IS NOT NULL AND status<>'sent' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 12"));

const wtp = await rows("SELECT r.amount_usd::float AS usd, left(r.note, 100) AS said, p.company, q.playbook FROM revenue r JOIN requests q ON q.id = r.request_id LEFT JOIN prospects p ON p.id = q.prospect_id WHERE r.kind='stated_willingness' AND r.recorded_at >= $1 ORDER BY 1 DESC");
const amounts = wtp.map((w) => Number(w.usd)).sort((a, b) => a - b);
console.log(`What people said they'd pay: ${wtp.length} answer(s)` + (amounts.length ? `, median USD ${amounts[Math.floor(amounts.length / 2)]}, range USD ${amounts[0]}-${amounts.at(-1)}` : ""));
if (wtp.length) console.table(wtp);

const client = await getNaive();
console.log("Naive balance now: USD", ((await client.credits.show()).balance_micro_usd / 1e6).toFixed(2));
process.exit(0);
