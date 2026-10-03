#!/usr/bin/env bash
# One-time live setup for the lucy bridge on Vercel. Run from anywhere:
#   bash ~/lucy-claude-mod/bridge/scripts/vercel-setup.sh
# Reads secrets from ~/.lucy-bridge/secrets.env (never printed), provisions
# Upstash Redis, sets env vars, deploys to production, verifies.
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="${LUCY_SECRETS:-$HOME/.lucy-bridge/secrets.env}"
SCOPE="${VERCEL_SCOPE:-ryan-bozsans-projects}"
PROJECT="${VERCEL_PROJECT:-lucy-bridge}"
vc() { npx -y vercel@latest "$@"; }
cd "$BRIDGE_DIR"

[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
[ -f .vercel/project.json ] || vc link --yes --scope "$SCOPE" --project "$PROJECT"

echo "== 1/5 Upstash Redis (Vercel Marketplace, free plan unless you pick another) =="
if vc env ls --scope "$SCOPE" 2>/dev/null | grep -q UPSTASH_REDIS_REST_URL; then
  echo "already connected"
else
  vc integration add upstash/upstash-kv --scope "$SCOPE" --name lucy-bridge-redis --no-env-pull
fi

echo "== 2/5 secrets from $SECRETS (values not shown) =="
for k in BRIDGE_PING_TOKEN OWNER_PASSPHRASE OWNER_SUBJECT; do
  v="$(grep "^$k=" "$SECRETS" | cut -d= -f2-)"
  [ -n "$v" ] || { echo "missing $k in $SECRETS"; exit 1; }
  for env in production preview; do
    vc env rm "$k" "$env" --yes --scope "$SCOPE" >/dev/null 2>&1 || true
    printf '%s' "$v" | vc env add "$k" "$env" --sensitive --yes --scope "$SCOPE" >/dev/null
    echo "  $k ($env): set"
  done
done

echo "== 3/5 first production deploy (to learn the public URL) =="
DEPLOY_URL="$(vc deploy --prod --yes --scope "$SCOPE" 2>/dev/null | tail -1)"
echo "deployment: $DEPLOY_URL"
PUBLIC_URL="${PUBLIC_URL:-https://$PROJECT.vercel.app}"
# The production alias can take a few seconds to attach after the first deploy.
code=000
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/healthz" || true)"
  case "$code" in 200|500) break ;; esac
  sleep 5
done
if ! echo "$code" | grep -qE '^(200|500)$'; then
  echo "!! $PUBLIC_URL answered $code; find the production alias in the Vercel dashboard and re-run with PUBLIC_URL=<alias> $0"
  exit 1
fi
echo "production alias: $PUBLIC_URL (answered $code before BRIDGE_PUBLIC_URL is set; 500 is expected here)"

echo "== 4/5 BRIDGE_PUBLIC_URL=$PUBLIC_URL and redeploy =="
for env in production preview; do
  vc env rm BRIDGE_PUBLIC_URL "$env" --yes --scope "$SCOPE" >/dev/null 2>&1 || true
  printf '%s' "$PUBLIC_URL" | vc env add BRIDGE_PUBLIC_URL "$env" --yes --scope "$SCOPE" >/dev/null
done
vc deploy --prod --yes --scope "$SCOPE" >/dev/null
echo "redeployed"

echo "== 5/5 verify =="
bash "$BRIDGE_DIR/scripts/verify-live.sh" "$PUBLIC_URL"
echo
echo "MCP server URL for ChatGPT: $PUBLIC_URL/mcp"
