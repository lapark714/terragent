# UI fixes from the integration pass (for Aiden and Aarush)

The integration audit found five issues whose fixes touch UI files you now own. Rather than push over your work,
the UI half is in [integration-ui-fixes.patch](integration-ui-fixes.patch). The server half is already on `main`.

Apply it if you want it (it applied cleanly to `main` at the time it was made):

```bash
git apply docs/handoff/integration-ui-fixes.patch
```

If it no longer applies cleanly, use it as a reference and copy the parts you want.

| # | What | Your files in the patch | Server side (already on main) |
|---|---|---|---|
| 1 | **Record a payment** (major): a "Record a payment" control in the Money panel, shown once founder controls are unlocked; pre-fills the amount still owed. Without it, the funnel's "paid" stage can never move. | `components/dashboard/RecordPayment.tsx` (new), `MoneyPanel.tsx`, `useAdminSession.ts` (shared `postAdmin`), `ApprovalsPanel.tsx` | `POST /api/admin/payment` |
| 2 | **No exception text on the public dashboard** (major): panels show "unavailable" instead of raw error messages, which could contain internals. | `Panel.tsx`, `BoardPanel.tsx`, `ApprovalsPanel.tsx` | `panel()` returns a fixed string; errors logged server-side |
| 3 | **Status page polling backs off**: 8 s, then 20 s after 5 quiet minutes, 60 s after 30; finished requests every 2 min. | `components/request/poll.ts` (+ test), `RequestProgressView.tsx`, `app/request/[id]/page.tsx` | status endpoint cached + per-IP limit |
| 4 | **Market prices panel** ("What it costs today"): cited prices of today's alternatives vs our $29 floor. DoD #8. | `components/dashboard/MarketPanel.tsx` (new), `MissionControl.tsx`, `app/dashboard/page.tsx` | `GET /api/dashboard/market` |
| 5 | **Landing page stops promising what the API doesn't do**: drops the "$9 per request" claim and `callback_url`. | `app/page.tsx` | — |

The shared types these use (`MarketPrice`, `MarketPrices`, `MarketResponse` in `src/lib/dashboard/types.ts`, and the
`payment.recorded` label in `src/components/format.ts`) are already on `main`; they are additions only.
