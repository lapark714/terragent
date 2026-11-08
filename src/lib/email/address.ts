/** Email address helpers. Every address we store or compare goes through normalizeEmail. */
import { z } from "zod";
import { env } from "../env";

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

export function isValidEmail(address: string): boolean {
  return z.email().safeParse(normalizeEmail(address)).success;
}

/** "Jane Doe <Jane@X.com>" | "jane@x.com" → { name: "Jane Doe", email: "jane@x.com" } */
export function parseAddress(raw: string): { name: string | null; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: normalizeEmail(m[2]) };
  return { name: null, email: normalizeEmail(raw) };
}

export function emailDomain(address: string): string {
  return normalizeEmail(address).split("@")[1] ?? "";
}

/** TEAM_EMAILS: founders' addresses that may receive mail before an inbox is armed (testing). */
export function teamEmails(): Set<string> {
  return new Set((env("TEAM_EMAILS") ?? "").split(",").map(normalizeEmail).filter(Boolean));
}
