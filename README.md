# smer

```text
   _____ __  ____________
  / ___//  |/  / ____/ __ \
  \__ \/ /|_/ / __/ / /_/ /
 ___/ / /  / / /___/ _, _/
/____/_/  /_/_____/_/ |_|
```

[![CI](https://github.com/vojtaholik/smer/actions/workflows/ci.yml/badge.svg)](https://github.com/vojtaholik/smer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f7d32.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS-black.svg)](https://www.apple.com/macos/)

**Local, event-driven work memory. A CLI, not an app.**

smer turns logs your tools already produce into one private, structured timeline at `~/.smer/smer.db`. The corpus is designed for two consumers: you can search it directly, and your own coding agent can mine it for content or evidence-backed workflow improvements. smer never calls an LLM and never sends data anywhere.

> [!NOTE]
> smer is early-stage software and currently targets macOS.

[Install](#install-from-source) | [First minute](#first-minute) | [Providers](#cloud-providers) | [Agent layer](#agent-layer) | [Contributing](CONTRIBUTING.md)

## What works

- SQLite WAL store with synchronized FTS5, BM25 ranking, and recency boost.
- Strict event validation, pre-insert secret redaction, project resolution, and source-aware dedupe.
- Shell capture with exit code and duration; zsh history and git reflog backfill.
- Bounded Claude Code, Codex, and Cursor transcript harvesters, plus content-free Cursor save metadata from local history.
- Figma desktop activity capture from recent document edit markers, with clean file/node deep links and no document contents.
- Copy-then-read Arc, Chrome, and Chromium history harvesting with domain denylists.
- Workspace discovery from git, package manifests, Vercel, and Wrangler metadata. `.env` bytes after `=` are discarded; only key names are retained for redaction and provider suggestions.
- Vercel, GitHub, Inngest, fal.ai, and Slack polling with credentials held in macOS Keychain.
- Idempotent ChatGPT export import from `conversations.json` or the official export zip, with an optional daemon-polled private inbox.
- Declarative custom API and JSONL providers, plus a supervised executable escape hatch.
- Full-screen terminal search, timeline, stats, an ambient prompt segment, and ADR-001 JSON output.
- Pause/resume gap markers, launchd daemon setup, diagnostics, and agent commands for digest, mining, retro, and provider creation.

No screenshots, OCR, Accessibility API, Full Disk Access, telemetry, accounts, embeddings, or cloud sync.

## Install from source

Build the single binary with Bun 1.2 or newer:

```sh
bun run build
install -m 755 dist/smer ~/.local/bin/smer
smer setup --dev-root ~/Developer
```

The included Homebrew formula installs the signed-off release artifact once `v0.1.0` is published:

```sh
brew install --formula https://raw.githubusercontent.com/vojtaholik/smer/main/Formula/smer.rb
```

Until then, use the source build above. A future tap will reduce the Homebrew flow to `brew install smer`.

`smer setup` creates the private store, installs the LaunchAgent, discovers projects, and backfills the last 30 days. It prints the optional shell-hook line; pass `--install-shell` to let setup add it to `.zshrc`. Use `--no-launchd` or `--no-backfill` for a narrower setup.

For development, run `bun src/cli.ts ...` or `bun link` from this directory.

## First minute

```sh
smer setup --dev-root ~/Developer --install-shell
smer doctor
smer timeline
smer search 'deploy AND failed' --since 7d
smer
```

Running `smer` with no arguments opens the TUI. In the TUI, type an FTS5 query and press Enter, use arrow keys to navigate, and press Ctrl-O to open a URL or source file.

## Commands

```text
smer search "query" [--project P] [--source S] [--kind K] [--since 7d] [--limit 25]
smer timeline [--day YYYY-MM-DD] [--project P] [--source S] [--kind K] [--since 7d]
smer stats [--source S] [--since 30d]
smer show EVENT_ID
smer emit --source ID --kind KIND --title TEXT [--text TEXT] [--spool]
smer pause 1h | smer resume
smer providers [list|run ID|enable ID|disable ID|add ID|credential ID]
smer workspace scan [ROOT]
smer projects map NAME --path PATH [--domain DOMAIN] [--keyword WORD]
smer backfill [all|shell|git|claude-code|codex|cursor|figma|browser]
smer import chatgpt EXPORT.zip
smer import jsonl EVENTS.jsonl
smer status --segment
smer doctor
smer daemon
smer automation digest enable --at 18:00
```

Every command accepts `--home PATH` and `--json`. JSON responses use:

```json
{
  "ok": true,
  "command": "search",
  "result": [],
  "next_actions": []
}
```

## ChatGPT and Codex

Codex capture is automatic from bounded reads of local `~/.codex` session logs. ChatGPT does not expose a supported local conversation log or read-only API; its desktop cache is encrypted, so smer only consumes official data exports.

Enable the private import inbox once, then place an official export zip or extracted `conversations.json` at its top level:

```sh
smer providers enable chatgpt
cp ~/Downloads/chatgpt-export.zip ~/.smer/imports/chatgpt/
smer providers run chatgpt
smer stats --source chatgpt --since 90d
smer stats --source codex --since 90d
```

The daemon checks the inbox every ten minutes and only reprocesses a file when its size or modification time changes. Conversation ids are upserted, so a newer export updates existing ChatGPT sessions instead of multiplying snapshots. No ChatGPT or Codex token is required.

## Event contract

All providers map into one strict envelope:

```json
{
  "ts": 1784140800,
  "source": "claude-code",
  "kind": "agent_session",
  "project": "roomka",
  "title": "Fix Inngest sync on apex domain",
  "text": "Dense searchable text",
  "meta": { "session_id": "abc", "cwd": "/Users/me/Developer/roomka" }
}
```

Built-in kinds are `shell_cmd`, `git_commit`, `agent_session`, `browser_visit`, `deploy`, `api_job`, and `note`. Custom kinds must begin with `x-`. Text is capped at 64KB and timestamps more than 24 hours in the future are rejected.

External emitters should call `smer emit --spool`; this validates and redacts before the spool write. The daemon ingests each spool file in one transaction. Hand-written spool files are accepted for interoperability, but their contents necessarily exist on disk before smer can redact them.

## Project attribution

Workspace discovery seeds path, repo, domain, and keyword signals. The resolver checks an explicit provider project, longest cwd prefix, repo remote, domain, then title/text keywords. Add an explicit mapping only after reviewing it:

```sh
smer projects map roomka \
  --path ~/Developer/roomka \
  --domain roomka.com \
  --keyword roomka
```

## Cloud providers

Tokens are prompted without echo and stored in Keychain. Request read-only tokens; smer never copies credentials from project `.env` files.

```sh
smer providers add vercel
smer providers add github --username YOUR_LOGIN
smer providers add inngest --endpoint https://YOUR_READ_API/runs
smer providers add fal --endpoint https://YOUR_READ_API/usage
smer providers add slack --channels engineering,releases
smer providers run vercel
```

Provider-specific endpoints can also be set in `~/.smer/config.toml`. Poll intervals are never shorter than 60 seconds.

Cursor is enabled by default and reads completed `.jsonl` or `.txt` transcripts under `~/.cursor/projects/*/agent-transcripts/` with the same 16 MB cap used by other agents. Each session event includes user requests, the final outcome, changed and consulted file paths, shell commands, tool counts, and failures. File contents and diff bodies are excluded. Recent sessions are left alone until they have been idle for ten minutes.

Figma is enabled by default on macOS and polls `~/Library/Application Support/Figma/settings.json` once per minute. It emits an `x-figma-file` event when a recent document's desktop `editedAt` marker advances. Events include the title, editor type, clean file/node link, and activity timestamps; transient viewport/session parameters, signed thumbnail URLs, and design contents are never stored. Because this is a private desktop schema rather than a supported Figma API, schema changes produce a provider warning instead of stopping the daemon. The marker can reflect document activity rather than a confirmed autosave by the current user.

Slack is opt-in. Create a single-workspace Slack app with a read-only bot token and grant `channels:read`, `groups:read`, `channels:history`, and `groups:history`; invite it only to channels smer should capture. Use `--channels` for an additional comma-separated allowlist. The initial run imports 30 days, then stores an independent timestamp cursor per channel. Add `--history-days N`, `--types public_channel,private_channel`, or `--team-id ID` when configuring the provider if needed.

## Custom providers

Place a config at `~/.smer/providers/<id>/provider.toml`. A JSONL tail looks like this:

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

API providers add `endpoint`, an optional `cursor`, and `auth = { keychain = "smer-service" }`. Store their token with `smer providers credential <id> --keychain smer-service`. Executable providers use `adapter = "executable"` and a `command` array; they must emit JSONL envelopes and are disabled after five consecutive failures.

The bundled [`add-smer-provider` skill](skills/add-smer-provider/SKILL.md) gives an agent the complete extension workflow.

## Agent layer

Setup installs `~/.smer/CLAUDE.md` and four command prompts:

- `digest.md`: today's blocks, wins, rough project time, open loops, and an optional cited post draft.
- `mine.md`: at least three ranked, evidence-backed content candidates.
- `retro.md`: no more than three concrete workflow changes backed by event ids.
- `new-provider.md`: choose an adapter, write a small provider, validate, run, retrieve, and diagnose.

The bundled [`smer` skill](skills/smer/SKILL.md) gives Codex and Claude Code a shared workflow for evidence-backed digests, project reconstruction, open-loop audits, content mining, and retrospectives. Install it globally for both agents from a stable checkout:

```sh
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s "$PWD/skills/smer" ~/.codex/skills/smer
ln -s "$PWD/skills/smer" ~/.claude/skills/smer
```

Invoke it explicitly as `$smer` in Codex or ask either agent to use the smer skill. New agent sessions discover newly installed skills.

Run a daily digest with your own agent, for example:

```sh
claude -p "$(cat ~/.smer/commands/digest.md)"
```

To schedule that command at 18:00 with a low-priority LaunchAgent, opt in explicitly:

```sh
smer automation digest enable --at 18:00
smer automation digest status
```

Disable it with `smer automation digest disable`. The generated digest stays in `~/.smer/digests/YYYY-MM-DD.md`; the automation shows a local notification but never publishes.

This boundary is deliberate: smer captures and structures; the user's agent does the thinking. Publishing remains human-approved.

## Privacy and budgets

The home directory is forced to mode `700`; config, prompts, and spool files use `600`. Redaction covers common API tokens, GitHub and AWS credentials, JWTs, valid card shapes, non-allowlisted emails, high-entropy tokens, and values adjacent to discovered env key names. `smer doctor` checks database integrity, FTS parity, WAL, provider health, daemon heartbeat, Codex log permissions, likely config secrets, daemon RSS, and estimated 24-hour writes.

Constitutional budgets are <100MB daemon RSS, <20MB event writes/day, no timer below 60 seconds, <5 seconds from spool to search, and <100ms search at 100k events. The included benchmark currently exercises the last target.

## Development

```sh
bun test
bun run check
bun run benchmark
bun run build
lat check
```

The project has no runtime dependencies beyond Bun and macOS system tools (`git`, `security`, `launchctl`, and `unzip`).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
