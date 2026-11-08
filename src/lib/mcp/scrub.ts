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

export function scrubForAgent(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (key && PERSON_KEYS.test(key)) return typeof value === "string" && value.trim() ? NAME_PLACEHOLDER : value;
  if (typeof value === "string") return key && ADDRESS_KEYS.test(key) && value.includes("@") ? EMAIL_PLACEHOLDER : value.replace(EMAIL, EMAIL_PLACEHOLDER);
  if (Array.isArray(value)) return value.map((v) => scrubForAgent(v, key && ADDRESS_KEYS.test(key) ? key : undefined));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubForAgent(v, k);
    return out;
  }
  return value;
}
