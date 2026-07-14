---
name: add-smer-provider
description: Add, test, or repair a custom smer capture provider. Use when a user asks to track another service, API, JSONL log, local tool, or workflow in smer; mentions provider.toml; or needs an existing custom provider diagnosed.
---

# Add an smer provider

Create the smallest reviewable provider that maps source records into smer's strict event envelope. Preserve retries and failures as evidence. Never put credentials in provider files or read credentials from project `.env` values.

## Choose the adapter

1. Inspect `smer providers --json` and the source's existing logs or API.
2. Prefer `log-tail` for an append-only JSONL file.
3. Use `api-poll` for a read-only HTTP API with stable ids and a cursor.
4. Use `executable` only when the declarative mappers cannot represent the source. The executable must write one complete event envelope per stdout line.

## Create the config

Write `provider.toml` under `${SMER_HOME:-$HOME/.smer}/providers/<id>/`. Use lowercase provider ids and custom kinds beginning with `x-`.

API example:

```toml
[provider.linear]
adapter = "api-poll"
endpoint = "https://api.linear.app/example/events"
interval = "10m"
cursor = "id"
auth = { keychain = "smer-linear", header = "Authorization", scheme = "Bearer" }

[provider.linear.map]
ts = "{createdAt}"
kind = "x-issue"
project = "{team.key}"
title = "{identifier}: {title}"
text = "{identifier} {state.name} {url}"
```

JSONL example:

```toml
[provider.local-tool]
adapter = "log-tail"
path = "~/Library/Logs/local-tool/events.jsonl"
interval = "1m"

[provider.local-tool.map]
ts = "{timestamp}"
kind = "x-local-tool"
project = "{project}"
title = "{action}"
text = "{action} {status} {detail}"
```

For an executable, set `adapter = "executable"` and `command = ["/absolute/path/to/emitter"]`. Omit `[provider.<id>.map]` when stdout already contains strict envelopes.

## Configure and verify

1. Store an API token with `smer providers credential <id> --keychain smer-<id>`. Request a read-only token.
2. Enable the provider with `smer providers add <id>`.
3. Validate a representative envelope with `smer emit --dry-run --json --source <id> --kind x-example --title "test" --text "test"`.
4. Run one collection pass with `smer providers run <id> --json`.
5. Confirm retrieval with `smer search "distinctive term" --json`.
6. Run `smer doctor --json` and fix provider health errors.

Check that `ts` is unix seconds or an ISO timestamp accepted by the mapper, `text` stays below 64KB, stable source ids prevent duplicate imports, and no secret appears in `config.toml`, `provider.toml`, spool files, or event output.
