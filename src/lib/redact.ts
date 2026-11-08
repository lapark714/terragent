/** Masks credentials that can appear in error text (DB URLs, API keys) before it leaves the server. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s@'"]+@/gi, "$1://***@")
    .replace(/\b(sk_live_|sk_test_|am_|monid_live_|tg_live_)[A-Za-z0-9_-]{6,}/g, "$1***");
}
