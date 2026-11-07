/**
 * Inbox roles → addresses. Usernames on the shared agentmail.to domain are global across
 * all AgentMail customers, so the addresses are config (env-overridable), not hard-coded.
 * Decided 2026-11-07 (NOTES H2b): terragent@ is hello; terragent-data@ and terragent-outreach@.
 */
import type { Inbox } from "@/lib/domain";

export interface InboxConfig {
  role: Inbox;
  address: string;
  username: string;
  displayName: string;
  /** Idempotency key for inboxes.create: same clientId returns the same inbox. */
  clientId: string;
  /** Which agent owns the inbox. */
  owner: "comms-customer" | "comms-suppliers" | "comms-outreach";
}

function inbox(role: Inbox, envVar: string, fallback: string, displayName: string, owner: InboxConfig["owner"]): InboxConfig {
  const address = (process.env[envVar] || fallback).toLowerCase();
  return { role, address, username: address.split("@")[0], displayName, clientId: `terragent-${role}-v1`, owner };
}

export function inboxes(): Record<Inbox, InboxConfig> {
  return {
    hello: inbox("hello", "AGENTMAIL_INBOX_HELLO", "terragent@agentmail.to", "Terragent", "comms-customer"),
    data: inbox("data", "AGENTMAIL_INBOX_DATA", "terragent-data@agentmail.to", "Terragent Data", "comms-suppliers"),
    outreach: inbox("outreach", "AGENTMAIL_INBOX_OUTREACH", "terragent-outreach@agentmail.to", "Terragent Outreach", "comms-outreach"),
  };
}

export function roleForAddress(address: string): Inbox | null {
  const a = address.toLowerCase();
  for (const cfg of Object.values(inboxes())) if (cfg.address === a) return cfg.role;
  return null;
}
