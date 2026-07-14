# Verification

The test suite proves corpus behavior, provider contracts, setup safety, daemon latency, and the compiled CLI's machine-readable interface.

## Corpus Invariants

Tests cover strict validation, redaction, attribution, dedupe, FTS retrieval, source-scoped search and timelines, per-source stats, and transactional spool recovery.

## Provider Contracts

Provider fixtures cover incremental, bounded, and failure-isolated ingestion across local and cloud sources.

Coverage includes workspace discovery, `.env` key names, shell and git history, bounded agent logs, Cursor context, Figma edit markers, browser and Slack cursors, API pagination, JSONL tails, and executable failure shutdown.

## Import And Setup

ChatGPT conversation ids upsert across manual and inbox imports, and unchanged inbox files are skipped. Setup installs agent prompts and project metadata without touching launchd or zsh when explicitly opted out.

Legacy database fixtures verify that a renamed binary opens `smem.db` rather than silently creating an empty `smer.db`. LaunchAgent and shell compatibility remain bounded migration behavior.

## Runtime Contract

A sibling-process test starts the daemon, emits through the spool, retrieves through FTS, and requires completion within the five-second latency budget.

## Performance Gate

The benchmark loads 100,000 events and measures repeated ranked FTS queries against the 100 ms p95 budget.

## Release Gate

The final gate runs in macOS CI and covers tests, the bundle check, the 100k-event benchmark, a standalone build, and `lat check`. Release preparation also verifies the archive checksum, formula syntax, and disposable-home smoke flow.
