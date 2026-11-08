/** Opt-out tokens (never the address in the URL) and the suppression list. */
import { agentmailErrorCode, mailApi } from "../agentmail/client";
import { getDb } from "../db/client";
import { publicBaseUrl } from "../env";
import { logEvent } from "../events";
import { newToken } from "../ids";
import { normalizeEmail } from "./address";

export type SuppressionReason = "opt_out" | "bounce" | "complaint" | "manual";

const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;

/** Stable per address, so links in older emails keep working. */
export async function optOutUrl(email: string): Promise<string> {
  const db = await getDb();
  const addr = normalizeEmail(email);
  await db.query("INSERT INTO optout_tokens (token, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING", [newToken(), addr]);
  const [row] = await db.query<{ token: string }>("SELECT token FROM optout_tokens WHERE email = $1", [addr]);
  return `${publicBaseUrl()}/unsubscribe?t=${row.token}`;
}

export async function emailForToken(token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const db = await getDb();
  const [row] = await db.query<{ email: string }>("SELECT email FROM optout_tokens WHERE token = $1", [token]);
  return row?.email ?? null;
}

export async function isSuppressed(email: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query("SELECT 1 FROM suppression WHERE email = $1", [normalizeEmail(email)]);
  return rows.length > 0;
}

/** A later, stronger reason replaces a weaker one (an opt-out after a bounce must still reach AgentMail's block list). */
const STRENGTH: Record<SuppressionReason, number> = { bounce: 0, manual: 1, complaint: 2, opt_out: 2 };

/**
 * Add to our suppression list (checked before every send). Opt-outs and manual suppressions also go on
 * AgentMail's org-wide send block list (AgentMail already blocks its own bounces/complaints), retried until it
 * succeeds; opt-outs and complaints stop the prospect being contacted.
 */
export async function suppress(email: string, reason: SuppressionReason, actor = "system"): Promise<void> {
  const db = await getDb();
  const addr = normalizeEmail(email);
  const [prev] = await db.query<{ reason: SuppressionReason; blocklisted_at: string | null }>(
    "SELECT reason, blocklisted_at FROM suppression WHERE email = $1", [addr]);
  const effective = prev && STRENGTH[prev.reason] >= STRENGTH[reason] ? prev.reason : reason;

  if (effective !== prev?.reason) {
    await db.query(
      "INSERT INTO suppression (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason", [addr, effective]);
    await logEvent("email.suppressed", actor, { email: addr, reason: effective, previous: prev?.reason ?? null });
  }
  if (effective === "opt_out" || effective === "complaint") {
    await db.query(
      "UPDATE prospects SET status = 'opted_out', updated_at = now() WHERE lower(contact_email) = $1 AND status <> 'opted_out'",
      [addr],
    );
  }
  if ((effective === "opt_out" || effective === "manual") && !prev?.blocklisted_at) await blockList(addr, effective, actor);
}

async function blockList(addr: string, reason: SuppressionReason, actor: string) {
  try {
    await mailApi().blockSend(addr, reason === "opt_out" ? "opted out" : "suppressed by Terragent");
  } catch (e) {
    const code = agentmailErrorCode(e);
    if (code !== "already_exists" && code !== "http_409") {
      await logEvent("email.blocklist_failed", actor, { email: addr, code });
      return;
    }
  }
  const db = await getDb();
  await db.query("UPDATE suppression SET blocklisted_at = now() WHERE email = $1", [addr]);
}

/** /unsubscribe confirm step. Returns the address on success, null for an unknown token. */
export async function unsubscribeByToken(token: string): Promise<string | null> {
  const email = await emailForToken(token);
  if (!email) return null;
  const db = await getDb();
  await db.query("UPDATE optout_tokens SET used_at = COALESCE(used_at, now()) WHERE token = $1", [token]);
  await suppress(email, "opt_out", "unsubscribe_page");
  return email;
}

/** "jane.doe@example.com" → "j•••@example.com" for confirmation pages. */
export function maskEmail(email: string): string {
  const [user, domain] = normalizeEmail(email).split("@");
  return `${user.charAt(0)}•••@${domain ?? ""}`;
}

/**
 * A message that is nothing but an opt-out ("Unsubscribe", "STOP", "Please remove me from your list."), for
 * mail that isn't a reply to our outreach. "How do I opt out of the county flood map?" is a question, not this.
 */
export function isOptOutCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  const first = t.split("\n")[0].replace(/[\s.!,]+$/, ""); // the command line; a short signature may follow
  if (!first || first.length > 80 || t.length > 300 || t.includes("?")) return false;
  return /^(please[\s,]+)?(unsubscribe|opt[\s-]?out|remove me|take me off|stop$|stop (emailing|contacting|sending|messaging|writing)\b)/.test(first);
}

/**
 * Opt-out intent in the NEW part of a reply (pass extracted_text, not the quoted history, so our own footer's
 * "opt out" wording never triggers it).
 */
export function isOptOutReply(replyText: string): boolean {
  const t = replyText.toLowerCase();
  if (/\b(unsubscribe|opt[\s-]?out|remove me|take me off)\b/.test(t)) return true;
  if (/\bstop (emailing|contacting|sending|messaging|writing)\b/.test(t)) return true;
  return t.split("\n").some((line) => /^\s*stop[\s.!]*$/.test(line));
}
