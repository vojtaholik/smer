# Verification

The test suite proves corpus behavior, provider contracts, setup safety, daemon latency, and the compiled CLI's machine-readable interface.

## Corpus Invariants

Tests cover strict validation, redaction, attribution, dedupe, FTS retrieval, source-scoped search and timelines, per-source stats, and transactional spool recovery.

## Provider Contracts

Provider fixtures cover incremental, bounded, and failure-isolated ingestion across local and cloud sources.

Coverage includes workspace discovery, `.env` key names, shell and git history, bounded agent logs, content-free Cursor save metadata, Figma edit markers, browser and Slack cursors, API pagination, JSONL tails, and executable failure shutdown.

### Git Working State

Git state capture emits branch and aggregate working-tree metadata on change while omitting filenames and content, and an unchanged scan produces no new corpus event.

### Local Asset Saves

Image save events retain filesystem metadata and project attribution while excluding image bytes from the event corpus, and repeated scans deduplicate an unchanged file version.

## Import And Setup

ChatGPT conversation ids upsert across manual and inbox imports, and unchanged inbox files are skipped. Setup installs agent prompts and project metadata without touching launchd or zsh when explicitly opted out.

Legacy database fixtures verify that a renamed binary opens `smem.db` rather than silently creating an empty `smer.db`. LaunchAgent and shell compatibility remain bounded migration behavior.

## Runtime Contract

A sibling-process test starts the daemon, emits through the spool, retrieves through FTS, and requires completion within the five-second latency budget.

### Brief Contract

The versioned brief compares exact current and prior windows, excludes derived observations, bounds detailed output, and attaches corpus event ids to deterministic deltas, failures, outcomes, and open-loop candidates.

### Conditional Pulse

The pulse ignores ambient browser and successful shell activity, summarizes notable work, and advances its durable window so subsequent runs do not repeat events.

### Conditional Pulse Health

The pulse reports stale daemon heartbeats and unhealthy enabled providers even when no notable events occurred during its current window.

## Performance Gate

The benchmark loads 100,000 events and measures repeated ranked FTS queries against the 100 ms p95 budget.

## Release Gate

The final gate runs in macOS CI and covers tests, the bundle check, the 100k-event benchmark, a standalone build, and `lat check`. Release preparation also verifies the archive checksum, formula syntax, and disposable-home smoke flow.
