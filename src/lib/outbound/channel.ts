/**
 * Who we may contact and how (NOTES 2026-11-07 "Outbound channel"):
 *   email_warm   — the contact wrote to us first, or a founder marked them warm;
 *   email_direct — cold work email from the Naïve inbox (never AgentMail), only when OUTREACH_DIRECT_EMAIL_APPROVED;
 *   contact_form — everyone else: the business's own website form, one touch per business.
 */
import { envFlag } from "../env";

export type OutreachChannel = "email_warm" | "email_direct" | "contact_form";

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "ymail.com", "rocketmail.com", "outlook.com", "msn.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "fastmail.com", "hey.com", "mail.com",
  "zoho.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "cox.net", "charter.net", "bellsouth.net",
  "earthlink.net", "btinternet.com", "web.de", "t-online.de", "orange.fr", "free.fr", "libero.it", "qq.com", "163.com",
]);
/** Providers with many country domains (yahoo.co.uk, hotmail.fr, gmx.de, …). */
const PERSONAL_PREFIXES = ["yahoo.", "hotmail.", "live.", "gmx.", "yandex."];

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
}

/** Consumer mailbox (likely an individual, not a work contact). */
export function isPersonalMailbox(email: string): boolean {
  const d = emailDomain(email);
  return PERSONAL_DOMAINS.has(d) || PERSONAL_PREFIXES.some((p) => d.startsWith(p));
}

/** "https://www.Acme.com/contact" → "acme.com". */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
  return host.includes(".") ? host : null;
}

/**
 * Hosts whose pages belong to many businesses (facebook.com/acme, acme.wixsite.com): their domain says nothing about
 * which business it is, so it is never used to dedupe or match prospects.
 */
const SHARED_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "yelp.com", "google.com", "goo.gl", "business.site", "wixsite.com", "wix.com", "squarespace.com", "godaddysites.com",
  "weebly.com", "wordpress.com", "blogspot.com", "linktr.ee", "nextdoor.com", "yellowpages.com",
  "bbb.org", "mapquest.com", "angi.com", "houzz.com", "thumbtack.com",
];

export function isSharedHost(domain: string): boolean {
  const d = domain.toLowerCase();
  return SHARED_HOSTS.some((h) => d === h || d.endsWith(`.${h}`));
}

export function chooseChannel(c: { email: string | null; warm: boolean; directApproved?: boolean }): {
  channel: OutreachChannel;
  reason: string;
} {
  const directApproved = c.directApproved ?? envFlag("OUTREACH_DIRECT_EMAIL_APPROVED");
  if (c.email && c.warm) return { channel: "email_warm", reason: "warm contact: they wrote to us or a founder marked them warm" };
  if (c.email && directApproved && !isPersonalMailbox(c.email)) {
    return { channel: "email_direct", reason: "cold work email; direct email approved (OUTREACH_DIRECT_EMAIL_APPROVED)" };
  }
  return {
    channel: "contact_form",
    reason: c.email ? "cold contact and direct email is not approved: use their website contact form" : "no work email: use their website contact form",
  };
}
