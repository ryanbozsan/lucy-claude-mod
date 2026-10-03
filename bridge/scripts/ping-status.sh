#!/usr/bin/env bash
# Bridge-side proof for one event: what the bridge recorded for an event ID.
#   bash bridge/scripts/ping-status.sh <eventId> [https://lucy-bridge.vercel.app]
# Reads the ping token from ~/.lucy-bridge/secrets.env; prints no secrets.
set -euo pipefail
ID="${1:?event id}"
URL="${2:-https://lucy-bridge.vercel.app}"
SECRETS="${LUCY_SECRETS:-$HOME/.lucy-bridge/secrets.env}"
TOKEN="$(grep '^BRIDGE_PING_TOKEN=' "$SECRETS" | cut -d= -f2-)"
curl -fsS -H "authorization: Bearer $TOKEN" "$URL/ping/$ID" | python3 -c '
import json, sys
r = json.load(sys.stdin)
print("eventId   ", r["eventId"])
print("status    ", r["status"], "(pings received:", r["pings"], ")")
print("sent      ", r["event"]["timestamp"], " received", r["receivedAt"])
for d in r["deliveries"]:
    print("delivery  ", d["subscriptionId"], d["status"], "http", d.get("httpStatus"), "attempts", d["attempts"], d.get("deliveredAt", ""), d.get("lastError", ""))
'
