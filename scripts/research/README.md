# Research one-offs

Throwaway probes from the build, kept for the record. They hit live Naïve and the production database, so read them before running.

- `naive-flag-*.ts`: the hunt for what makes Naïve flag a session as having read people's data (NOTES, 2026-11-08). No trigger we control was found; the approval policy in `src/lib/pipeline/approval-policy.ts` was the fix.
- `naive-probe-computer.ts`: first checks of a Naïve sandbox computer before the imagery pipeline moved there.
