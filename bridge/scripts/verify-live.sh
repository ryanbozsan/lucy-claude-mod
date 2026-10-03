#!/usr/bin/env bash
# Proof-level B preflight against a deployed bridge. No secrets needed.
#   bash bridge/scripts/verify-live.sh https://lucy-bridge.vercel.app
set -euo pipefail
URL="${1:?public bridge url}"
URL="${URL%/}"
pass=0; fail=0
check() { if "$@"; then pass=$((pass+1)); echo "  ok   $desc"; else fail=$((fail+1)); echo "  FAIL $desc"; fi; }

desc="healthz answers 200"
check bash -c "curl -fsS '$URL/healthz' | grep -q '\"ok\":true'"

desc="protected-resource metadata names $URL/mcp"
check bash -c "curl -fsS '$URL/.well-known/oauth-protected-resource' | grep -q '\"resource\":\"$URL/mcp\"'"

desc="authorization-server metadata advertises S256 and CIMD"
check bash -c "curl -fsS '$URL/.well-known/oauth-authorization-server' | grep -q 'client_id_metadata_document_supported\":true' "

desc="unauthenticated /mcp returns 401 with resource_metadata challenge"
check bash -c "curl -s -o /dev/null -D - -X POST '$URL/mcp' -d '{}' | grep -qi 'www-authenticate: Bearer resource_metadata='"

desc="/ping without token returns 401"
check bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$URL/ping' -d '{}')\" = 401 ]"

echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
