import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import type { Db } from "../db/client";
import { emailForToken, isOptOutCommand, isOptOutReply, isSuppressed, maskEmail, optOutUrl, suppress, unsubscribeByToken } from "./optout";
import { fakeMail, memoryDb, resetDb, type FakeMail } from "./testing";

let db: Db;
let mail: FakeMail;

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
});
afterAll(async () => {
  setMailApi(null);
  vi.unstubAllEnvs();
  await db.close();
});

const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

describe("opt-out tokens", () => {
  it("are opaque, stable per address and case-insensitive", async () => {
    const a = await optOutUrl("Pat@Acme.com");
    const b = await optOutUrl("pat@acme.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^https:\/\/terragent\.test\/unsubscribe\?t=[A-Za-z0-9]{24}$/);
    expect(a).not.toContain("acme");
    expect(await emailForToken(tokenOf(a))).toBe("pat@acme.com");
    expect(await optOutUrl("other@acme.com")).not.toBe(a);
  });

  it("reject malformed and unknown tokens", async () => {
    expect(await emailForToken("")).toBeNull();
    expect(await emailForToken("'; DROP TABLE x; --")).toBeNull();
    expect(await emailForToken("A".repeat(24))).toBeNull();
  });

  it("unsubscribe flow: suppresses, blocks in AgentMail, opts the prospect out", async () => {
    await db.query("INSERT INTO prospects (id, playbook, company, contact_email, status) VALUES ('pro_1', 'disasters', 'Acme', 'Pat@acme.com', 'emailed')");
    const token = tokenOf(await optOutUrl("pat@acme.com"));
    expect(await isSuppressed("pat@acme.com")).toBe(false);

    expect(await unsubscribeByToken(token)).toBe("pat@acme.com");
    expect(await isSuppressed("PAT@acme.com")).toBe(true);
    expect(mail.blockSend).toHaveBeenCalledWith("pat@acme.com", "opted out");
    const [p] = await db.query<{ status: string }>("SELECT status FROM prospects WHERE id = 'pro_1'");
    expect(p.status).toBe("opted_out");
    const [t] = await db.query<{ used_at: string | null }>("SELECT used_at FROM optout_tokens WHERE token = $1", [token]);
    expect(t.used_at).not.toBeNull();

    // Second click is a no-op (no duplicate block-list call).
    await unsubscribeByToken(token);
    expect(mail.blockSend).toHaveBeenCalledTimes(1);
    expect(await unsubscribeByToken("Z".repeat(24))).toBeNull();
  });
});

describe("suppress", () => {
  it("keeps going when the AgentMail block list call fails, and logs it", async () => {
    mail.blockSend.mockRejectedValueOnce(new Error("boom"));
    await suppress("x@y.com", "manual");
    expect(await isSuppressed("x@y.com")).toBe(true);
    const events = await db.query<{ type: string }>("SELECT type FROM events ORDER BY id");
    expect(events.map((e) => e.type)).toEqual(["email.suppressed", "email.blocklist_failed"]);
  });

  it("offline: suppresses locally without calling AgentMail, and reaches the block list on the next online suppress", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    await suppress("off@y.com", "opt_out");
    expect(await isSuppressed("off@y.com")).toBe(true);
    expect(mail.blockSend).not.toHaveBeenCalled();
    vi.stubEnv("TERRAGENT_OFFLINE", "");
    await suppress("off@y.com", "opt_out");
    expect(mail.blockSend).toHaveBeenCalledWith("off@y.com", "opted out");
  });

  it("doesn't call AgentMail for bounces (AgentMail already suppresses those)", async () => {
    await suppress("b@y.com", "bounce");
    expect(mail.blockSend).not.toHaveBeenCalled();
  });

  it("retries a failed block-list call on the next suppress, then stops calling", async () => {
    mail.blockSend.mockRejectedValueOnce(new Error("boom"));
    await suppress("x@y.com", "opt_out");
    await suppress("x@y.com", "opt_out");
    await suppress("x@y.com", "opt_out");
    expect(mail.blockSend).toHaveBeenCalledTimes(2);
  });

  const reasonOf = async (email: string) => (await db.query<{ reason: string }>("SELECT reason FROM suppression WHERE email = $1", [email]))[0].reason;

  it("an opt-out after a bounce upgrades the reason, reaches the block list and opts the prospect out", async () => {
    await db.query("INSERT INTO prospects (id, playbook, company, contact_email, status) VALUES ('pro_b', 'mining', 'Ore', 'b@y.com', 'emailed')");
    await suppress("b@y.com", "bounce");
    await suppress("B@y.com", "opt_out");
    expect(await reasonOf("b@y.com")).toBe("opt_out");
    expect(mail.blockSend).toHaveBeenCalledWith("b@y.com", "opted out");
    const [p] = await db.query<{ status: string }>("SELECT status FROM prospects WHERE id = 'pro_b'");
    expect(p.status).toBe("opted_out");
  });

  it("a bounce never downgrades an opt-out", async () => {
    await suppress("o@y.com", "opt_out");
    await suppress("o@y.com", "bounce");
    expect(await reasonOf("o@y.com")).toBe("opt_out");
    const events = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE type = 'email.suppressed'");
    expect(events[0].n).toBe(1);
  });
});

describe("isOptOutReply", () => {
  it.each([
    "unsubscribe", "Please remove me from your list.", "STOP", "stop.", "Stop emailing me", "I'd like to opt out", "take me off this list",
  ])("detects %j", (text) => expect(isOptOutReply(text)).toBe(true));

  it.each([
    "Can you check the flood at our site?", "Don't stop the monitoring, it's useful", "What would it cost to stop the erosion?",
  ])("ignores %j", (text) => expect(isOptOutReply(text)).toBe(false));
});

describe("isOptOutCommand (mail that isn't a reply to our outreach)", () => {
  it.each(["Unsubscribe", "STOP", "stop.", "Please remove me from your list.", "unsubscribe\n\nPat Doe\nAcme Corp", "Stop emailing me"])(
    "detects %j", (text) => expect(isOptOutCommand(text)).toBe(true));

  it.each([
    "How do I opt out of the county flood map?", "Stop the erosion at our quarry: can you measure it", "Can you unsubscribe me?",
    "We want to monitor our depot. Please remove me from the old contact and use ops@acme.com instead, and send the quote.", "",
  ])("ignores %j", (text) => expect(isOptOutCommand(text)).toBe(false));
});

it("maskEmail hides the local part", () => {
  expect(maskEmail("Jane.Doe@Example.com")).toBe("j•••@example.com");
});
