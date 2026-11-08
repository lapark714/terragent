import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("masks database credentials and API keys in error text", () => {
    const msg = "connect failed: postgresql://neondb_owner:pa55word@ep-x-pooler.neon.tech/db key sk_live_abcdef123456 am_us_0123456789ab";
    const out = redactSecrets(msg);
    expect(out).not.toContain("pa55word");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("0123456789ab");
    expect(out).toContain("postgresql://***@ep-x-pooler.neon.tech/db");
  });
});
