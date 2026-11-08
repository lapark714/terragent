# Cold email: compliance and deliverability (Terragent weekend run)

Researched 2026-11-08 UTC (Sat 2026-11-07 evening PT). Scope: cold B2B email sent from a Naïve identity inbox, with AgentMail kept for intake and replies (NOTES.md decision "Email stack change"). Laws and mailbox-provider rules come from primary sources (listed in §7). Account facts come from read-only `GET`s against `api.vetta.sh` and public DNS lookups made the same night. This is research, not legal advice.

**Verdict.** Cold email to US businesses at "dozens" volume is legal if every message has a few specific elements (§1), and it's technically workable from the Naïve system domain. Four problems need fixing before the next send. Three come from what is already live (§0): an address that probably doesn't count, a missing "this is a solicitation" label, and a send path that skips our code gates. The fourth is that the platform under Naïve email appears to ban cold outreach too.

---

## 0. What the live account shows (read-only checks, 2026-11-08 ~01:35 UTC)

| Item | Finding | Source |
|---|---|---|
| Sending domain | `terragent-qqhrnj.usenaive.ai`, `kind: system` (Naïve's free per-org subdomain), `status: active`, `dns_status: provisioned`, created 2026-11-08 00:56 UTC. No domain was bought. | `GET /v1/domains` |
| Identity / inbox | Identity `Terragent` (`idn_9zr1…`) with inbox `outreach@terragent-qqhrnj.usenaive.ai` (`eml_sbxj…`), owner agent `terragent-outreach` (`agt_zx12…`), `wake: true`. | `GET /v1/identities`, `…/emails` |
| Agent config | `terragent-outreach` v2, `anthropic/claude-sonnet-5`. Only `email.read`, `email.send` and `email.inboxes` are enabled, **all set to `allow`** (the platform default for `email.send` is ask). No MCP servers, so **it doesn't use our gateway**: none of `src/lib/email/send.ts`'s gates run (suppression list, daily caps, approved template, `OUTREACH_DIRECT_EMAIL_APPROVED`, postal-address check). Budget $10/month, $3/task. | `GET /v1/agents/agt_zx12…` |
| **Already sent** | **44 cold emails**, 00:59–01:28 UTC (5:00–5:28 pm PT Sat), to 44 distinct addresses on 44 distinct domains. Sends came in bursts of 8–10 a minute, several within the same 30 ms. TLDs: 39 `.com`, 2 `.ag`, 1 each `.claims` `.net` `.org`; no freemail. 29 of 44 went to role addresses (`info@`, `contact@`…). Most are price-discovery surveys ("what would one report be worth to you? (a)…(d)"), not a free analysis of the recipient's asset. | `GET /v1/identities/{id}/sent` (aggregates only; no recipient data copied here) |
| Footer on all 44 | "Sent by Terragent's AI agent from 459 Lagunita Drive, Stanford, CA 94305; reply "stop" to opt out." The address is hard-coded in the agent's system prompt. `COMPANY_POSTAL_ADDRESS` is **not** set in `.env`. | agent `system`; `.env` key names |
| Address check | Public sources give 459 Lagunita Drive as **Tresidder Memorial Union** (Stanford's student union, which has a Starbucks). Unless a founder has a mailbox there, it isn't "the sender's current street address" (§1.1). | events.stanford.edu, web search |
| Inbound so far | 1 message, an auto-reply (`guard_reason: auto_reply`, so no session started). No bounce notifications. Naïve's API doesn't expose bounces or complaints at all (provider message id "deliberately not surfaced"). | `GET /v1/identities/{id}/messages` |
| Sending provider | DNS: `resend._domainkey` DKIM, a `send.` return-path subdomain with `MX feedback-smtp.us-east-1.amazonses.com` and `v=spf1 include:amazonses.com ~all`. That is **Resend's** standard record set. Inbound MX is `receive.forge.rmta.net`. | DNS over HTTPS (Cloudflare) |
| Resend's AUP | "You are prohibited from sending unsolicited messages of any kind… including cold outreach, purchased lists, or scraped contact data". It also requires complaints under 0.08% and bounces under 4%, or "your account may be shut down without warning" (updated 2026-10-13). | resend.com/legal/acceptable-use |
| Naïve ToS | Don't "use the Service to generate spam"; "You are responsible for compliance with those third parties' terms" (§4.2, §5.2; updated 2026-10-28). The docs give no cold-email rule and no outbound send caps. | usenaive.ai/terms; identity/email.md; api/messaging.md |

**What this means.** If Naïve email does go out through Resend (likely from the DNS, but unconfirmed), moving cold mail from AgentMail to Naïve moves the "no cold outreach" problem down one layer instead of removing it. A complaint now lands on Naïve's provider account and on the shared `usenaive.ai` domain that every Naïve customer sends from. **Get the Naïve team's written OK** (they're the on-site sponsor) before sending more. The OK should cover the use case: "one free, specific analysis of the business's own asset, AI-disclosed, opt-out, ≤ ~25/day".

---

## 1. What every cold email must contain

### 1.1 United States: CAN-SPAM (applies to us; B2B is not exempt)

The FTC guide is explicit: "The law makes no exception for business-to-business email." Our cold emails promote Terragent's service, so the FTC's "primary purpose" test makes them **commercial**. That includes the price surveys and the free-report offers. The penalty is up to **$53,088 per non-compliant email**. Hiring someone else to send doesn't move the liability: "Both the promoted company and the sending company may be held responsible."

| # | Requirement | Statute / rule | What Terragent must do | 44 sent emails |
|---|---|---|---|---|
| 1 | **Truthful headers**: From, To, Reply-To and routing must "identify the person or business who initiated the message". | 15 U.S.C. 7704(a)(1) | From name "Terragent" on our own domain. No fake "Re:"/"Fwd:", no personal-sounding human names for the agent. | OK |
| 2 | **Subject not misleading** about a material fact in the body. | 7704(a)(2) | The subject describes what's inside ("Satellite view of <asset> after <event>"). Say "free" only if it is free. | OK as far as checked |
| 3 | **Identify it as an advertisement or solicitation**, "clear and conspicuous". The wording is flexible, but it must be there, unless the recipient gave prior affirmative consent. | 7704(a)(5)(A)(i), (a)(5)(B) | One plain line, e.g. "This is a one-time commercial message from Terragent." | **Missing** |
| 4 | **Valid physical postal address** of the sender. 16 CFR 316.2(p) accepts exactly three forms: (a) the sender's **current street address**; (b) a **USPS PO box** "the sender has accurately registered" with USPS; (c) a **private mailbox registered with a commercial mail receiving agency (CMRA)** set up under USPS rules, i.e. a "virtual mailbox" registered with USPS Form 1583. | 7704(a)(5)(A)(iii); 16 CFR 316.2(p) | A founder supplies a real one: their own business or home address, a PO box, or a CMRA mailbox, in `COMPANY_POSTAL_ADDRESS`. Don't make one up and don't use a public building. | **Likely invalid** (student union) |
| 5 | **Opt-out notice**: "clear notice" of the right to decline, plus a **functioning return email address or internet-based mechanism**, clearly and conspicuously displayed. | 7704(a)(3)(A), (a)(5)(A)(ii) | Reply "stop" is a valid mechanism. An HTTPS opt-out link is optional. Make sure our own filters can't swallow opt-out replies. | Present ("reply stop") |
| 6 | **The mechanism must keep working for ≥ 30 days** after each send. | 7704(a)(3)(A)(ii) | Keep `outreach@terragent-qqhrnj.usenaive.ai` active and monitored until **≥ 30 days after the last cold send** (≥ 2026-12-08 for the current batch). Don't delete the identity, inbox or domain after the hackathon. | Needs a commitment |
| 7 | **Honour opt-outs within 10 business days**. You can't charge a fee, ask for anything beyond the email address, or require more than a reply or one web page. | 7704(a)(4); 16 CFR 316.5; FTC guide | Suppress **immediately** and automatically. Resend's AUP requires 7 days and Google/Yahoo expect 2 days for bulk senders, so instant is the only safe target. | Agent memory only (see §4) |
| 8 | **Never sell or transfer** opted-out addresses (except to a compliance vendor). | 7704(a)(4)(A)(iv) | The suppression list stays internal. | n/a |
| 9 | **No harvesting or dictionary attacks** (aggravated, criminal). That means no addresses scraped by automated means from sites that prohibit it, and no addresses generated "by combining names, letters, or numbers into numerous permutations". | 7704(b)(1) | Only published addresses or verified lookups (e.g. Monid). **Never auto-guess `first.last@` patterns.** | Unknown source |

### 1.2 United Kingdom: PECR + UK GDPR

- **Corporate subscribers** (companies, LLPs, Scottish partnerships, government bodies) are outside PECR reg 22's consent rule. Reg 22 "applies to … individual subscribers" only, so cold B2B email to a company is allowed without consent.
- **PECR reg 23 applies to every recipient.** Don't disguise or conceal the sender's identity, and provide "a valid address to which the recipient … may send a request that such communications cease".
- **Sole traders and non-LLP partnerships count as individual subscribers.** They need consent or the soft opt-in, so **don't cold email them**. A one-person business at `bob@bobsplumbing.co.uk` is a sole trader.
- **UK GDPR still applies to named people at company addresses** (`jane.smith@firm.co.uk`). You need a legitimate-interests basis (Art 6(1)(f); Recital 47: "direct marketing … may be regarded as carried out for a legitimate interest"). You must also give Art 14 privacy information and flag the Art 21 right to object, both at the first communication (see §1.3). Generic role addresses (`info@`) mostly avoid this.
- The ICO recommends keeping a "do not email" list of objecting corporate subscribers and screening new lists against it.
- The Data (Use and Access) Act 2025 raised PECR's maximum fine from £500k to £17.5m or 4% of turnover. Secondary sources say this commenced on 2026-02-05; not checked against legislation.gov.uk.

### 1.3 European Union: ePrivacy Art 13 + GDPR (plus national law)

- **ePrivacy Directive Art 13(1)** requires prior consent for direct-marketing email to natural persons. **Art 13(5)** leaves "subscribers other than natural persons" to national law, so **the B2B rule differs by member state**.
- **Germany (UWG §7(2) Nr. 2)** counts email advertising "ohne dass eine vorherige ausdrückliche Einwilligung des Adressaten vorliegt" (without the addressee's prior express consent) as unreasonable nuisance. That covers every addressee, businesses included. **No cold email to German recipients.** Other states are reported to vary (not researched here).
- **GDPR, where the recipient is an identifiable person:**
  - **Art 14(3)(b)**: privacy information (who we are, purposes, legal basis, legitimate interest, **source of the data** under Art 14(2)(f), and rights) "at the latest at the time of the first communication". In practice: one line plus a link to a privacy notice. **Terragent has no privacy page** (`src/app/` has `terms` and `acceptable-use` only).
  - **Art 21(2)–(4)**: the right to object to direct marketing is absolute. It must be "explicitly brought to the attention of the data subject … clearly and separately from any other information" at the first communication.
  - **Art 3(2)** brings a non-EU company into scope when it offers services to people in the EU.
- **Recommendation for the weekend: exclude EU recipients.** The rules vary by country, Germany bans it outright, and we'd need a privacy notice. That leaves the US plus, optionally, UK companies at role addresses.

### 1.4 Canada (CASL), noted only

The CRTC FAQ returned 403 and wasn't verified. As commonly understood, CASL needs consent; implied consent covers a business address that is "conspicuously published", carries no "no unsolicited messages" notice, and the message is relevant to the person's role. The message must give identification, a mailing address and an unsubscribe that works for 60 days, honoured within 10 business days. **Exclude Canada for the weekend** unless someone verifies this.

### 1.5 Platform terms (they bite before any regulator does)

| Platform | Rule | Consequence |
|---|---|---|
| AgentMail | KB: AgentMail "does not support cold outreach"; ToS 8(h) bans unsolicited promotional email, 8(j) requires AI disclosure (from `agentmail.md` row 1). | An org-wide suspension would stop `hello@`/`data@` sending. This is why cold mail is moving off AgentMail. |
| Resend (inferred provider under Naïve email) | Bans cold outreach outright; complaints < 0.08%, bounces < 4%, opt-outs honoured within 7 days. | Resend can shut down *Naïve's* account, so Naïve will likely suspend whoever caused it. |
| Naïve | No spam; you must follow third-party terms; you approve agent actions (ToS §4.2, §5.1, §5.2). | Suspension (ToS §13.2). |

---

## 2. Deliverability for a new domain

### 2.1 Mailbox-provider rules, and which apply to us

| Provider | All senders | Bulk senders | Applies to Terragent? |
|---|---|---|---|
| **Google (Gmail)** | SPF **or** DKIM; valid forward and reverse DNS (PTR); TLS; RFC 5322 format; don't impersonate Gmail From; spam rate in Postmaster Tools **below 0.3%**, target **below 0.10%**. | Above **5,000/day to personal Gmail**: SPF **and** DKIM **and** DMARC (`p=none` is enough); From aligned with SPF or DKIM; **one-click unsubscribe (RFC 8058)** plus a visible unsubscribe link in the body for marketing; honour unsubscribes within 48 h. Once you cross the threshold you stay a bulk sender permanently. Enforcement has been ramping since **Nov 2025**, with temporary and then permanent rejections. | All-sender rules: **yes**. Bulk rules: **no** (we're far below 5,000/day). Google's FAQ also says the sender guidelines **"don't apply to messages sent to Google Workspace accounts"**, which is where most B2B recipients are. Gmail's spam filter still applies to them. |
| **Yahoo** | SPF or DKIM; valid forward and reverse DNS; RFC 5321/5322; spam rate **< 0.3%**. | SPF **and** DKIM; DMARC at least `p=none` that **passes**; relaxed alignment OK; one-click List-Unsubscribe (RFC 8058 POST "highly recommended", mailto "acceptable"); visible unsubscribe link; honour within 2 days. DKIM key ≥ 1024 bits recommended. | Same as Google. B2B recipients are rarely on Yahoo. |
| **Microsoft (Outlook.com consumer)** | n/a | Since **5 May 2025**, domains sending **> 5,000/day** to outlook.com/hotmail.com/live.com need SPF pass, DKIM pass, and DMARC `p=none` or stricter aligned with SPF or DKIM. Failures go to Junk, with rejection (`550 5.7.515`) announced for later. Recommended: a From/Reply-To that accepts replies, a working unsubscribe, list hygiene. | No (volume, and consumer domains only). **Microsoft 365 business tenants** filter with Exchange Online Protection under each tenant's own policies; the page above doesn't cover them. |
| **RFC 8058** | n/a | `List-Unsubscribe: <https://…>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, both covered by a valid DKIM signature. The POST must not redirect and must not rely on cookies or auth. | Can't be done today: Naïve's send body is only `{to, subject, text}`, with no headers, HTML, Reply-To, CC/BCC or attachments (SDK `EmailSend`; api/messaging.md). Not required at our volume. |

### 2.2 DNS: what's live on our system domain, and what's missing

| Record (live, checked over DNS-over-HTTPS) | Value | Assessment |
|---|---|---|
| DKIM `resend._domainkey.terragent-qqhrnj.usenaive.ai` | RSA public key, **1024-bit** | Passes, and `d=` matches the From domain exactly. 1024-bit meets Yahoo's minimum; 2048 is better. We can't change it. |
| SPF on return path `send.terragent-qqhrnj.usenaive.ai` | `v=spf1 include:amazonses.com ~all`, `MX feedback-smtp.us-east-1.amazonses.com` | Passes. Aligns with the From domain under relaxed alignment (shared org domain `usenaive.ai`). |
| DMARC `_dmarc.terragent-qqhrnj.usenaive.ai` | `v=DMARC1; p=none;` | Meets the minimum. **No `rua=`**, so we get no aggregate reports. Platform-managed, so we can't add one. (`_dmarc.usenaive.ai` has no record.) |
| MX `terragent-qqhrnj.usenaive.ai` | `10 receive.forge.rmta.net` | Replies come back to our inbox, which Microsoft recommends (a "reply-able" From). |
| `rsend.…` CNAME | `send.forge.rmta.net` | Purpose unknown (perhaps a second sending path). |

What we **can't** do on a system domain: edit records (the docs say the shared zone "is list-only for you", and edits return 403); verify the domain in **Google Postmaster Tools** (that needs a TXT record), so we can't see our Gmail spam rate; add `rua` reporting; or see bounces and complaints. The org domain `usenaive.ai` was registered **2026-03-08** (RDAP), so the subdomain inherits about 8 months of domain age. Its reputation is **shared with every Naïve tenant**: their spam hurts us, and ours hurts them.

**If we bought our own domain instead** (`POST /v1/domains/purchase` needs `billing:write`, a price ceiling and founder approval; not quoted, since the quote endpoint is a POST):

- Naïve publishes the same record set: SPF, DKIM, MX, `_dmarc`.
- Ideally add a `rua` mailbox, a one-page website on the apex, and Google Postmaster Tools verification.
- A **0-day-old domain is a negative signal** for spam filters on day 1, so buying one tonight wouldn't help deliverability this weekend. It would only isolate reputation, so `usenaive.ai` and our `hello@` aren't affected.
- Keep cold mail on its own domain or subdomain, never on the domain that sends customer reports.

### 2.3 Warm-up and volume

Primary sources give **no cold-email warm-up schedule**. What they do say:
- **Google:** "Increase sending volume slowly", "Send email at a consistent rate. Avoid sending email in bursts", start "with a low sending volume to engaged users".
- **Resend's** baseline for a **new domain** of *permission-based* mail: Day 1 up to 150, Day 2 up to 250, Day 3 up to 400, Day 4 up to 700 (50/h max), Day 5 up to 1,000 (75/h), Day 6 up to 1,500 (100/h), Day 7 up to 2,000 (150/h). Slow down if bounces reach 4% or spam reaches 0.08%.
- **AgentMail's** KB (as recorded in `agentmail.md`): new-sender ramp of 10 → 20 → 40/day per inbox; no third-party warm-up tools.

Cold mail to strangers draws more complaints than opted-in mail, so treat Resend's table as an upper bound. **Recommended for one cold-sending domain or inbox (judgment based on the above):**

| Day | New cold recipients/day | Pacing | Continue only if |
|---|---|---|---|
| 1 | **20–25** | ≤ 10/hour, ≥ 3 min apart, recipient's business hours | 0 complaints, 0 "who is this / spam" replies, hard bounces ≤ 1 |
| 2 | 25–30 | same | same |
| 3–4 | 30–40 | ≤ 12/hour | hard bounces < 2% |
| 5–7 | 40–50 | ≤ 15/hour | reply rate holding; no complaint |
| Any day | **halve volume** after 1 complaint or bounces ≥ 3%; **stop** at 2 complaints or bounces ≥ 4% | | |

Resend's 0.08% complaint ceiling means **one complaint in 44 emails is already about 2.3%**. At our volume, a single "report spam" click matters more than any DNS record.

### 2.4 Content practices for cold B2B (Terragent-specific)

- **Plain text, short (60–120 words), one specific finding, one ask.** Naïve only sends plain text, which suits cold mail.
- **No links, images, tracking pixels or attachments in the first email.** Naïve can't attach files anyway. Offer the before/after image on reply ("Reply 'yes' and I'll send the images and the one-page report"). If you must link, use one HTTPS link on our own domain, never a URL shortener. Be wary of `*.vercel.app` links: shared hosting domains are common in phishing (deliverability judgment, not a cited rule).
- **Personalise by asset, not just by name:** the parcel or site, the event, the date of the imagery, one number. That is also our §8 product promise.
- **Verified addresses only:** published on the business's site or verified by a lookup service; check the domain has an MX record before sending; never guess patterns. Bounces are invisible to us on Naïve, so prevention is the only control.
- **Vary the content.** Many identical bodies at once look like a campaign. The 44 shared just 8 subject lines, and the most common one went out 11 times.
- **Weekend timing:** B2B mail on a Sunday gets few replies and stands out. Send in the recipient's local morning if possible.
- **After disasters, be helpful, not alarming** (spec §8). No "act now", no implied claim outcomes.

### 2.5 Is sending from a fresh domain on day 1 realistic?

**Yes for dozens, no for hundreds.** Authentication is in place on day 1 (DKIM, SPF and DMARC pass and align), so mail gets *accepted*. *Inbox placement* is uncertain: no sending history, no Postmaster visibility, a shared platform domain, a random-looking subdomain, and Microsoft 365 tenants that quarantine unknown senders. Expect some share to land in spam or quarantine. The share is unmeasured, and we can't measure it on this stack. The levers that work in 24 hours are low volume, steady pacing, real relevance, verified addresses and zero complaints.

---

## 3. Is AI disclosure legally required?

| Law | What it says | Applies to our cold email? | Verdict |
|---|---|---|---|
| **California BOT Act**, Bus. & Prof. Code §17941 (in force since 2019; text unchanged as of 2026-11-02) | Unlawful to "use a bot to communicate or interact with another person in California online, with the intent to mislead the other person about its artificial identity" to incentivize a sale. "Not liable … if the person discloses that it is a bot." Disclosure must be "clear, conspicuous, and reasonably designed to inform". | Uncertain. §17940(b) defines "online" as "appearing on any public-facing Internet Web site, Web application, or digital application", and private email may not count. It also needs *intent to mislead*. | **Disclose anyway**: disclosure is the statutory safe harbour and costs nothing. (AB 410 (2025) would amend the Act; its status wasn't verified.) |
| **EU AI Act Art 50(1), (5)** (applies from **2 Aug 2026**, Art 113; secondary sources say the 2026 Digital Omnibus didn't change Art 50(1)) | Providers must ensure AI systems "intended to interact directly with natural persons" inform them "that they are interacting with an AI system", unless obvious. Under Art 50(5) this must be "clear and distinguishable … at the latest at the time of the first interaction". | **Yes, for EU recipients.** Terragent "develops an AI system … [and] puts [it] into service under its own name" (Art 3(3) "provider"). Art 2(1)(c) reaches non-EU providers "where the output … is used in the Union". Our agent emails and answers replies, which is direct interaction. | Required for EU recipients (whom we exclude anyway). Art 50(2) machine-readable marking falls on generative-model providers, not on us. Art 50(4) covers text published to inform the public, not private email. |
| **US federal (FTC Act §5)** | No general AI-disclosure rule for email. Deception is unlawful, e.g. passing the agent off as a named human salesperson. | Yes | Don't invent a human persona. |
| **Platform terms** | AgentMail ToS 8(j) requires AI disclosure. Naïve ToS §4.2 makes legally required AI disclosure the customer's responsibility. | Yes on AgentMail (replies) | Required on AgentMail. |
| Other US state laws (e.g. Utah's AI disclosure law, Maine's 2025 chatbot law) | Consumer-facing; not checked against primary text. | Probably not (B2B) | Our disclosure covers them anyway. |

**How to phrase it.** Make it its own sentence, near the top or at the sign-off rather than in fine print, and keep it true:
- The repo's existing constant is `AI_DISCLOSURE` in `src/lib/email/templates.ts`: "This email was written and sent by an AI agent at Terragent, an AI-run company." Use it.
- Shorter, for the opening line: "I'm Terragent's AI agent (an automated system), writing because…"
- Add "a founder reads every reply" **only if that's actually true**.

---

## 4. Terragent checklist and day-1 volume

### 4.1 Before any further cold send (blockers)

1. [ ] **A founder confirms or replaces the postal address.** Tresidder Union isn't valid unless we have a mailbox there. Options: a founder's real address, a USPS PO box, or a CMRA virtual mailbox (USPS Form 1583). Set `COMPANY_POSTAL_ADDRESS` and take the address out of the agent prompt. Don't make one up (NOTES.md decision 4).
2. [ ] **Written OK from the Naïve team** that cold B2B outreach from a system subdomain is allowed, given Resend's AUP. If they say no: buy a domain, or stay on contact forms (the existing default channel).
3. [ ] **Put the code gates back on the send path.** Either route Naïve sends through our gateway (one MCP tool that runs `send.ts`'s gates, then calls `emails.send`), or at minimum set the outreach agent's `email.send` to `ask` and give it a gateway tool that checks suppression, caps and the template. Today the agent can email anyone, any number of times.
4. [ ] **Add the solicitation label** to the footer (§1.1 #3).
5. [ ] **One shared suppression list** (our DB `suppress()`) checked before every send on both stacks. Feed it from Naïve inbox replies containing stop / unsubscribe / remove / "not interested" / "take me off", and from AgentMail. **Poll `GET /v1/identities/{id}/messages`** rather than relying on the wake alone: the wake guards (`auto_reply`, `sender_rate_limit` 5/h, `endpoint_rate_limit` 20/h, `thread_turn_cap`) store some messages without starting a session.

### 4.2 Every cold email

- [ ] From: `Terragent <outreach@…>`; a subject that matches the body; no fake Re:/Fwd:.
- [ ] One specific finding about *their* asset (place, date, number) and a clear next step and price (spec §8).
- [ ] An AI-disclosure sentence (§3).
- [ ] "This is a one-time commercial message from Terragent."
- [ ] A valid postal address.
- [ ] An opt-out: "Reply 'stop' and we won't email you again." Optionally an HTTPS `/unsubscribe?t=<opaque token>` link (never the address in the URL).
- [ ] Recipient is a **US business** (or a UK company at a role address); **not** a sole trader, consumer, EU (especially German) or Canadian address.
- [ ] Address was published or verified, not guessed; MX checked; not on the suppression list; first touch to this business (one touch per business).
- [ ] Plain text, ≤ 120 words, no links, images or attachments in the first touch.

Example footer (plain text):

```
Terragent (AI-run Earth intelligence)
This email was written and sent by an AI agent at Terragent, an AI-run company.
This is a one-time commercial message. Terragent, <VALID POSTAL ADDRESS>.
Reply "stop" and we won't email you again.
```

### 4.3 After sending

- [ ] Keep the outreach inbox, identity and domain **alive and monitored for 30 days after the last send** (≥ 2026-12-08 for the current batch). Budget for woken sessions: each inbound wake is billed to the agent's per-task budget.
- [ ] Opt-outs take effect the same day (legal maximum: 10 business days).
- [ ] Log every touch: recipient domain, template version, time, channel. That's the audit trail, and the dashboard funnel.
- [ ] Ask Naïve for bounce and complaint data, since the API exposes none. Any sign of a complaint means pausing.

### 4.4 Day-1 volume

- **Rule of thumb for a cold domain on day 1: 20–25 new recipients, ≤ 10/hour, spaced ≥ 3 minutes** (§2.3).
- **This domain has already used that budget:** 44 sends in 29 minutes, in bursts. Its first 24 hours run to about 00:56 UTC Mon 2026-11-09, which covers the rest of the hackathon.
- **Recommendation:** after blockers 1–5 are fixed, **at most ~20 more cold emails this weekend**, steadily paced on Sunday morning PT, and only while there are no complaints or "who is this" replies. That brings the weekend total to about 60–65, which meets the "dozens" goal. After that, follow the §2.3 ramp, or stop cold email entirely if Naïve says no.

---

## 5. Unverified, or inferred

- That Naïve's outbound email goes through **Resend** is inferred from the DNS records (`resend._domainkey`, SES return path). The `rmta.net` records suggest a second component. Not confirmed by Naïve.
- Whether Naïve adds any headers (List-Unsubscribe, Precedence) or a footer to outbound mail; any outbound rate limit; the per-send price.
- Whether the 44 emails were delivered or reached the inbox. There's no bounce or complaint data.
- Whether a founder approved those 44 sends and the Stanford address. The address's use is from public listings; we don't know whether any founder has a mailbox there.
- Recipient countries, inferred from TLDs (`.ag` and `.claims` are generic-use TLDs).
- Secondary sources only: Digital Omnibus status (Regulation (EU) 2026/1744, Art 50(1) unchanged), the DUAA PECR fine commencement (2026-02-05), CASL details (CRTC page 403), and the ICO's corporate-subscriber page (403; used the PECR reg 22/23 text plus the ICO search snippet).
- California AB 410 (2025) status.
- Warm-up numbers in §2.3 are judgment informed by Google, Resend and AgentMail guidance. They aren't a published standard for cold mail.

## 6. Costs

- System domain: free, one per org (Naïve docs). Already in use.
- Naïve sends: credit-checked, price not published. Inbound wakes are billed as sessions under the agent's per-task budget ($3/task, $10/month on `terragent-outreach`).
- A purchased domain: not quoted (the quote endpoint is a POST, so it wasn't called). Needs `billing:write` and founder approval.
- PO box or CMRA mailbox: a founder pays if needed (USPS or a CMRA; typically monthly; not quoted).
- Legal exposure: up to $53,088 per non-compliant US email (FTC); UK PECR up to £17.5m or 4% (secondary).

## 7. Sources (primary unless marked)

- FTC, *CAN-SPAM Act: A Compliance Guide for Business*: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- 15 U.S.C. §7704: https://www.law.cornell.edu/uscode/text/15/7704
- 16 CFR §316.2 (valid physical postal address), §316.5: https://www.law.cornell.edu/cfr/text/16/316.2
- Google, Email sender guidelines: https://support.google.com/a/answer/81126, and FAQ: https://support.google.com/a/answer/14229414
- Yahoo Sender Hub, best practices: https://senders.yahooinc.com/best-practices/
- Microsoft, Outlook high-volume sender requirements (Apr 2025): https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730
- RFC 8058: https://www.rfc-editor.org/rfc/rfc8058.html
- PECR regs 22 and 23: https://www.legislation.gov.uk/uksi/2003/2426/regulation/22, https://www.legislation.gov.uk/uksi/2003/2426/regulation/23
- ICO, business-to-business marketing (403 to fetch; quoted via search): https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/
- GDPR (Recital 47, Arts 3, 6, 14, 21): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679
- ePrivacy Directive Art 13 (consolidated): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02002L0058-20091219
- German UWG §7: https://www.gesetze-im-internet.de/uwg_2004/__7.html
- EU AI Act (Arts 2, 3, 50, 113): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689
- California Bus. & Prof. Code §§17940–17941: https://california.public.law/codes/business_and_professions_code_section_17941 (and §17940)
- Resend, Acceptable Use Policy: https://resend.com/legal/acceptable-use, and warm-up guide: https://resend.com/docs/knowledge-base/warming-up
- Naïve: https://usenaive.ai/terms, https://usenaive.ai/docs/identity/email.md, https://usenaive.ai/docs/identity/domains.md, https://usenaive.ai/docs/identity/inbound.md, https://usenaive.ai/docs/api/messaging.md; SDK `@usenaive-sdk/managed-agents@0.12.3` `dist/index.d.ts` (`EmailSend`, `domains`, `emails`)
- Secondary: Digital Omnibus / Art 50 timing (iubenda, fedil.lu, Goodwin 2026-08); DUAA commencement (JD Supra, Bratby Law); Tresidder Union address (events.stanford.edu/tresidder_union)
- Account facts: read-only `GET /v1/domains`, `/v1/identities`, `/v1/identities/{id}/emails|sent|messages`, `/v1/agents/{id}` (2026-11-08 ~01:35 UTC); DNS over HTTPS (Cloudflare); RDAP for `usenaive.ai`. Raw JSON is in the session scratchpad (`research/naive-email/compliance-get-*.json`), not the repo.
