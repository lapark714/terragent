/**
 * Read-only checks against the real AgentMail org: inbox config matches, and our parsers read real messages
 * the same way from the SDK (camelCase) and from webhook JSON (snake_case). Never sends.
 * Bodies are compared as booleans so a failure can't print mail content (some inbound mail holds keys).
 *   npx vitest run --config vitest.live.config.mts src/lib/agentmail/client.live.test.ts
 */
import { serialization } from "agentmail";
import { describe, expect, it } from "vitest";
import { fromSdkMessage, fromWireMessage } from "../email/inbound-parse";
import { agentmailSdk, mailApi } from "./client";
import { inboxes } from "./config";

describe.skipIf(!process.env.AGENTMAIL_API_KEY)("AgentMail (live, read-only)", () => {
  it("has our three inboxes", async () => {
    const live = (await agentmailSdk().inboxes.list({ limit: 50 })).inboxes.map((i) => i.inboxId.toLowerCase());
    for (const cfg of Object.values(inboxes())) expect(live).toContain(cfg.address);
  });

  it("parses real messages identically from the SDK and from webhook-shaped JSON", async () => {
    let checked = 0;
    for (const cfg of Object.values(inboxes())) {
      const page = await mailApi().listMessages(cfg.address, { limit: 5 });
      for (const item of page.messages.filter((m) => m.labels.includes("received"))) {
        const full = await mailApi().getMessage(cfg.address, item.messageId);
        const sdk = fromSdkMessage(full);
        const wire = fromWireMessage(serialization.Message.jsonOrThrow(full, { unrecognizedObjectKeys: "passthrough" }));
        expect({ ...sdk, replyText: "", fullText: "" }).toEqual({ ...wire, replyText: "", fullText: "" });
        expect(sdk.replyText === wire.replyText && sdk.fullText === wire.fullText).toBe(true);
        expect(sdk.fullText.length > 0 || full.size === 0).toBe(true);
        expect(["pending", "clear", "review", "unavailable"]).toContain(sdk.security.verdict);

        const thread = await mailApi().getThread(full.threadId);
        expect(thread.messages.some((m) => m.messageId === full.messageId)).toBe(true);
        checked++;
      }
    }
    console.log(`[live] parsed ${checked} received message(s)`);
  });
});
