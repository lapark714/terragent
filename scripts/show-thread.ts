/** Print a stored email thread (our DB copy, newest last): npx tsx scripts/show-thread.ts <thread_id> [--last] */
import "dotenv/config";
import { getThread } from "../src/lib/email/threads";

const [threadId, ...flags] = process.argv.slice(2);
if (!threadId) throw new Error("usage: show-thread.ts <thread_id> [--last]");
const t = await getThread(threadId);
if (!t) throw new Error(`no thread ${threadId}`);
const msgs = flags.includes("--last") ? t.messages.slice(-1) : t.messages;
for (const m of msgs) console.log(`--- ${m.direction} ${m.at} | ${m.subject}\n${m.text}\n`);
process.exit(0);
