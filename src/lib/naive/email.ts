/**
 * Cold email goes out from the Naïve identity's inbox (Laurence, 2026-11-08: Naïve supports cold outreach; AgentMail
 * doesn't). Our gateway sends it, so every gate in src/lib/email/send.ts still applies. Replies land in that inbox and
 * are read by src/lib/email/naive-inbox.ts. Naïve's send takes only { to, subject, text }: no html, Reply-To or headers.
 */
import { coldInbox } from "../agentmail/config";
import { getNaive } from "./client";

/** Replies from one address share a synthetic thread: Naïve exposes no thread or message id for a send. */
export const naiveThreadId = (email: string) => `naive:${email.toLowerCase()}`;

export async function sendColdEmail(a: { to: string; subject: string; text: string }): Promise<{ messageId: null; threadId: string }> {
  const { identityId, inboxId } = coldInbox();
  const client = await getNaive();
  await client.emails.send(identityId, inboxId, { to: [a.to], subject: a.subject, text: a.text });
  return { messageId: null, threadId: naiveThreadId(a.to) };
}
