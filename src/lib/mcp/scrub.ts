/**
 * Strip personal data from tool results before they reach a Naïve agent.
 *
 * Verified live (2026-11-08): when an MCP tool result contains personal data (here a customer's name and email from
 * get_request), Naïve flags the chat as having "read people's data" and every later MCP call asks a human, even at
 * `allow` — the whole unattended pipeline parks. A probe session calling PII-free tools was not flagged. Agents never
 * need raw addresses or names: the server resolves recipients from request/prospect ids when it sends, and email
 * templates fill names server-side.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Keys whose values identify a person by name. */
const PERSON_KEYS = /^(customer_name|contact_name|sender_name|from_name|to_name|full_name|first_name|last_name|person_name)$/i;
/** Keys whose values are (or contain) email addresses. */
const ADDRESS_KEYS = /^(customer_email|contact_email|counterpart_email|email|emails|from|to|cc|bcc|reply_to|sender|recipient|recipients)$/i;

export const EMAIL_PLACEHOLDER = "[email on file]";
export const NAME_PLACEHOLDER = "[name on file]";

/**
 * Known person names for the request at hand (customer, prospect contact). Live run #2 showed Naïve also flags a
 * person's name in FREE TEXT (a handoff brief saying "Customer: Laurence"), so names are scrubbed everywhere, not
 * only in name fields. Full names and their tokens (≥ 3 letters) are replaced.
 */
function namePatterns(names: readonly (string | null | undefined)[]): RegExp[] {
  const terms = new Set<string>();
  for (const n of names) {
    const full = (n ?? "").trim();
    if (full.length < 3) continue;
    terms.add(full);
    for (const t of full.split(/\s+/)) if (/^\p{L}[\p{L}'-]{2,}$/u.test(t)) terms.add(t);
  }
  return [...terms]
    .sort((a, b) => b.length - a.length)
    .map((t) => new RegExp(`(?<![\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "giu"));
}

/** Scrub emails and the given person names from free text (handoff briefs, notes). */
export function scrubText(text: string, names: readonly (string | null | undefined)[] = []): string {
  let out = text.replace(EMAIL, EMAIL_PLACEHOLDER);
  for (const re of namePatterns(names)) out = out.replace(re, NAME_PLACEHOLDER);
  return out;
}

export function scrubForAgent(value: unknown, key?: string, names: readonly (string | null | undefined)[] = []): unknown {
  return walk(value, key, namePatterns(names));
}

function walk(value: unknown, key: string | undefined, names: RegExp[]): unknown {
  if (value === null || value === undefined) return value;
  if (key && PERSON_KEYS.test(key)) return typeof value === "string" && value.trim() ? NAME_PLACEHOLDER : value;
  if (typeof value === "string") {
    if (key && ADDRESS_KEYS.test(key) && value.includes("@")) return EMAIL_PLACEHOLDER;
    let out = value.replace(EMAIL, EMAIL_PLACEHOLDER);
    for (const re of names) out = out.replace(re, NAME_PLACEHOLDER);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, key && ADDRESS_KEYS.test(key) ? key : undefined, names));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k, names);
    return out;
  }
  return value;
}
