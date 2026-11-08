/**
 * PII masking for public surfaces (dashboard, status pages). The dashboard is public:
 * people show up as initials + email domain, free text is scrubbed of contact details and
 * house numbers, and request locations are coarsened before they reach the globe.
 */

/** "Jane van Doe" → "J.v.D." */
export function initials(name: string | null | undefined): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => p[0] + ".").join("");
}

/** "jane@acme.com" → "acme.com" */
export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
}

/** Public label for a customer: initials and/or email domain, never the full name or address. */
export function maskPerson(p: { name?: string | null; email?: string | null }): string | null {
  const label = [initials(p.name), emailDomain(p.email)].filter(Boolean).join(" at ");
  return label || null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w.])(?:\+?\d[\d\s().-]{7,}\d)(?![\w.])/g;
const STREET =
  "(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|hwy|highway|pkwy|parkway|cir|circle|trl|trail)";
const HOUSE_NUMBER_RE = new RegExp(`\\b\\d{1,6}[A-Za-z]?(\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9'.-]+\\s+){1,3}${STREET}\\b)`, "gi");
/** A house number, but not a year ("during 2019"). */
const NUM = "(?!(?:19|20)\\d\\d\\b)\\d{1,5}[A-Za-z]?";
/** "12 Rue de Rivoli", "8 bis, boulevard Haussmann": French numbers come first. */
const NUMBER_BEFORE_STREET_RE = new RegExp(`\\b${NUM}(?:\\s?(?:bis|ter))?,?(\\s+(?:rue|boulevard|bd|chemin|quai|impasse|allée)\\b)`, "giu");
/** "Hauptstraße 5", "Keizersgracht 123", "Storgatan 7": the number follows a street word. */
const NUMBER_AFTER_STREET_RE = new RegExp(
  `((?:straße|strasse|str\\.|weg|gasse|platz|allee|damm|straat|gracht|laan|plein|vej|gade|gatan|vägen|katu|ulica|utca),?\\s+)${NUM}\\b`,
  "giu",
);
/** "Via Roma 4", "Calle Mayor, 5": a capitalised Italian/Spanish/Portuguese street word, its name, then the number. */
const ROMANCE_STREET_RE = new RegExp(`(\\b(?:Via|Viale|Corso|Piazza|Calle|Avenida|Carrer|Rua|Praça)(?:\\s+[\\p{L}'.-]+){1,3},?\\s+)${NUM}\\b`, "gu");
/** UK postcodes such as "NW1 6XE". */
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
/** Full request ids open a customer's status page and report tokens open their report, so both are cut. */
const REQUEST_ID_RE = /\breq_([a-z0-9]{4})[a-z0-9]{2,}\b/g;
const REPORT_TOKEN_RE = /(\/r\/|[?&]r=)[A-Za-z0-9]{16,64}/g;

/** Removes capability ids, email addresses, phone numbers, postcodes and street numbers from free text. */
export function scrubText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(REQUEST_ID_RE, "req_$1")
    .replace(REPORT_TOKEN_RE, "$1[token]")
    .replace(EMAIL_RE, "[email]")
    .replace(HOUSE_NUMBER_RE, "#$1")
    .replace(NUMBER_BEFORE_STREET_RE, "#$1")
    .replace(NUMBER_AFTER_STREET_RE, "$1#")
    .replace(ROMANCE_STREET_RE, "$1#")
    .replace(UK_POSTCODE_RE, "[postcode]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));
}

/**
 * A locality safe for the public board: only what follows the street part, at most two pieces.
 * "Flat 2, 5 Oak Ave, Leeds, UK" → "Leeds, UK"; "Hauptstraße 5, 10115 Berlin" → "Berlin"; "Jane Doe, 5 Oak Ave" → null.
 */
export function coarsePlace(text: string | null | undefined): string | null {
  const parts = (text ?? "")
    .split(",")
    .map((p) => scrubText(p).replace(/\b\d{4,6}\b/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const street = parts.findLastIndex((p) => /[\d#[]/.test(p));
  const tail = parts.slice(street + 1).slice(-2);
  return tail.length ? tail.join(", ").slice(0, 80) : null;
}

/** Coarsens a coordinate to ~11 km so a public marker never pinpoints a home. */
export function coarsen(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "req_7k2mx9p3qa" → "req_7k2m": enough to talk about, not enough to open its status page. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  const [prefix, rest] = id.split("_", 2);
  return rest ? `${prefix}_${rest.slice(0, 4)}` : id.slice(0, 8);
}

/** Recursively scrubs strings inside tool arguments shown on the public approvals panel. */
export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return scrubText(v).slice(0, 400);
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrubValue(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, scrubValue(x, depth + 1)]));
}
