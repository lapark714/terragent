import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "@/lib/agentmail/client";
import type { Db } from "@/lib/db/client";
import { isSuppressed, optOutUrl } from "@/lib/email/optout";
import { fakeMail, memoryDb, resetDb, type FakeMail } from "@/lib/email/testing";
import { confirmUnsubscribe } from "./actions";
import UnsubscribePage from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

let db: Db;
let mail: FakeMail;

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
  redirect.mockClear();
});
afterAll(async () => {
  setMailApi(null);
  await db.close();
});

const render = async (params: Record<string, string>) => renderToStaticMarkup(await UnsubscribePage({ searchParams: Promise.resolve(params) }));
const tokenFor = async (email: string) => new URL(await optOutUrl(email)).searchParams.get("t")!;

describe("/unsubscribe", () => {
  it("shows an error for a missing or unknown token", async () => {
    expect(await render({})).toContain("This link doesn&#x27;t work");
    expect(await render({ t: "Z".repeat(24) })).toContain("This link doesn&#x27;t work");
  });

  it("asks for confirmation first (GET never unsubscribes), showing only a masked address", async () => {
    const t = await tokenFor("jane.doe@acme.com");
    const html = await render({ t });
    expect(html).toContain("Unsubscribe from Terragent emails?");
    expect(html).toContain("j•••@acme.com");
    expect(html).not.toContain("jane.doe");
    expect(html).toContain(`value="${t}"`);
    expect(await isSuppressed("jane.doe@acme.com")).toBe(false);
  });

  it("the confirm action suppresses, blocks in AgentMail and shows the done state", async () => {
    const t = await tokenFor("jane.doe@acme.com");
    const form = new FormData();
    form.set("t", t);
    await confirmUnsubscribe(form);
    expect(redirect).toHaveBeenCalledWith(`/unsubscribe?t=${t}&done=1`);
    expect(await isSuppressed("jane.doe@acme.com")).toBe(true);
    expect(mail.blockSend).toHaveBeenCalledWith("jane.doe@acme.com", "opted out");
    expect(await render({ t, done: "1" })).toContain("You&#x27;re unsubscribed");
  });
});
