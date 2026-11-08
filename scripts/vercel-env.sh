#!/usr/bin/env bash
# Copy Terragent's runtime environment from .env into the Vercel project. A founder runs this
# (spec §0: humans enter credentials). Values go to the Vercel CLI over stdin and are never printed.
#
#   bash scripts/vercel-env.sh --dry-run        # show which names would be set
#   bash scripts/vercel-env.sh [project-name]   # default project: terragent
#
# Needs: `npx vercel login` done once, and VETTA_DEPLOY_API_KEY in .env — a NARROW Naïve key (NOTES H1d,
# (no admin, no billing:write; NOTES H1d). The local admin key in VETTA_API_KEY is never uploaded:
# on Vercel, VETTA_API_KEY is set to the narrow key, and the app refuses to start with an admin key.
set -euo pipefail

cd "$(dirname "$0")/.."
DRY_RUN=0
PROJECT="terragent"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) PROJECT="$arg" ;;
  esac
done

[ -f .env ] || { echo "No .env in $(pwd)" >&2; exit 1; }

# Read a KEY=VALUE from .env without executing it; strip one layer of matching quotes.
# (Plain function, not an associative array: macOS ships bash 3.2.)
env_get() {
  local line val
  line="$(grep -E "^[[:space:]]*$1=" .env | tail -n 1)" || true
  [ -n "$line" ] || return 0
  val="${line#*=}"
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  printf '%s' "$val"
}

if [ -z "$(env_get VETTA_DEPLOY_API_KEY)" ]; then
  echo "VETTA_DEPLOY_API_KEY is missing from .env." >&2
  echo "Mint a narrow Naïve key (scopes agents:*, sessions:*, files:*, computers:write, billing:read, audit:read, webhooks:*; NO admin, NO billing:write)," >&2
  echo "add it to .env as VETTA_DEPLOY_API_KEY, then re-run. (NOTES H1d)" >&2
  exit 1
fi

# name on Vercel | source name in .env | secret?
VARS=(
  "VETTA_API_KEY|VETTA_DEPLOY_API_KEY|secret"
  "VETTA_BASE_URL|VETTA_BASE_URL|config"
  "DATABASE_URL|DATABASE_URL|secret"
  "AGENTMAIL_API_KEY|AGENTMAIL_API_KEY|secret"
  "AGENTMAIL_INBOX_HELLO|AGENTMAIL_INBOX_HELLO|config"
  "AGENTMAIL_INBOX_DATA|AGENTMAIL_INBOX_DATA|config"
  "AGENTMAIL_INBOX_OUTREACH|AGENTMAIL_INBOX_OUTREACH|config"
  "MONID_API_KEY|MONID_API_KEY|secret"
  "FIRMS_MAP_KEY|FIRMS_MAP_KEY|secret"
  "GFW_API_KEY|GFW_API_KEY|secret"
  "ADMIN_TOKEN|ADMIN_TOKEN|secret"
  "TEAM_EMAILS|TEAM_EMAILS|config"
  "PUBLIC_BASE_URL|PUBLIC_BASE_URL|config"
  "PAYMENT_LINK_URL|PAYMENT_LINK_URL|config"
  "OUTREACH_DIRECT_EMAIL_APPROVED|OUTREACH_DIRECT_EMAIL_APPROVED|config"
  "CAP_EMAILS_PER_DAY|CAP_EMAILS_PER_DAY|config"
  "CAP_OUTREACH_PER_DAY|CAP_OUTREACH_PER_DAY|config"
  "CAP_MONID_PER_CALL_USD|CAP_MONID_PER_CALL_USD|config"
  "CAP_MONID_PER_DAY_USD|CAP_MONID_PER_DAY_USD|config"
  "PRICE_AUTO_APPROVE_CAP_USD|PRICE_AUTO_APPROVE_CAP_USD|config"
  "PRICE_MIN_REPORT_USD|PRICE_MIN_REPORT_USD|config"
  "CAP_FREE_SAMPLES_PER_DAY|CAP_FREE_SAMPLES_PER_DAY|config"
  "PORTAL_RATE_PER_HOUR|PORTAL_RATE_PER_HOUR|config"
  "PORTAL_GLOBAL_PER_HOUR|PORTAL_GLOBAL_PER_HOUR|config"
  "COMPANY_POSTAL_ADDRESS|COMPANY_POSTAL_ADDRESS|config"
  "OUTREACH_CONTACT_FORM_APPROVED|OUTREACH_CONTACT_FORM_APPROVED|config"
)

if [ "$DRY_RUN" = 0 ]; then
  npx --yes vercel@latest whoami >/dev/null 2>&1 || { echo "Run 'npx vercel login' first." >&2; exit 1; }
fi

set_count=0; skip_count=0
for spec in "${VARS[@]}"; do
  IFS='|' read -r name src kind <<<"$spec"
  val="$(env_get "$src")"
  if [ -z "$val" ]; then
    echo "  skip  $name (no $src in .env)"; skip_count=$((skip_count + 1)); continue
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "  would set  $name  ($kind, from $src)"
  else
    flag="--sensitive"; [ "$kind" = config ] && flag="--no-sensitive"
    printf '%s' "$val" | npx --yes vercel@latest env add "$name" -e production,preview --force "$flag" -p "$PROJECT" --yes >/dev/null
    echo "  set   $name  ($kind)"
  fi
  set_count=$((set_count + 1))
done
echo "Done: $set_count set, $skip_count skipped (project: $PROJECT). Redeploy for changes to take effect."
