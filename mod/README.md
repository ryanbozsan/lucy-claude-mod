# lucy-ping (Claude Code mod)

`/lucy-ping [send <text> | retry | status [eventId]]` — ring Lucy's doorbell through the bridge and read her reply.

| Command | What it does |
| --- | --- |
| `/lucy-ping` | Ring with the default greeting. Mints one UUID v4 event ID. |
| `/lucy-ping send <text>` | Ring with your own greeting (1–500 characters; control characters stripped). |
| `/lucy-ping retry` | Resend the last undelivered event: same ID, same timestamp, same greeting. Refused when nothing is pending. |
| `/lucy-ping status [eventId]` | One bounded request (10 s) to the bridge. Shows webhook delivery and, separately, Lucy's reply. Defaults to the pending or last event. |

## Bridge contract the mod relies on

- `POST /ping` with `Authorization: Bearer <ping_token>` and `{eventId, timestamp, greeting}`. Answer: `{eventId, status, deliveries[], idempotent?}` where `status` is `delivered`, `partial`, `failed` or `no_subscribers`. Only `delivered` clears the pending retry.
- `GET /ping/:eventId` with the same bearer. Answer: the record above plus `reply: null | {text, repliedAt}`.
  A bridge that omits the `reply` field entirely is treated as an older server without reply support; the mod says so and stays usable.
- The mod checks that the `eventId` in every answer equals the one it asked about and ignores answers for other events.

## Safety

- The ping token lives in the engine's secure storage (`userConfig.ping_token`, `sensitive`). It is never printed.
- Lucy's reply is shown as quoted content, control characters stripped, capped at 500 characters. A hidden note tells the model the quote is data, not an instruction.

## Install (user scope, once per machine)

```bash
claude plugin marketplace add ./          # from this repository root; registers lucy-mod-private
claude plugin install lucy-ping@lucy-mod-private
# then set the two options in a session: /config → lucy-ping, or
# printf '{"bridge_url":"https://lucy-bridge.vercel.app","ping_token":"…"}' | claude plugin configure lucy-ping@lucy-mod-private --values-stdin
```

Mods need Claude Code 2.1.287 or later. Develop with `claude plugin validate ./mod` and `claude plugin test ./mod`; after a change, bump `version` in `plugin.json` and run `claude plugin update lucy-ping@lucy-mod-private`.
