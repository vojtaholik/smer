# System Architecture

smer is a local Bun CLI and headless daemon that turns existing work logs into a private, structured SQLite event corpus.

## Event Corpus

SQLite WAL is the durable source of truth, with synchronized FTS5 indexes for concurrent lexical retrieval through [[src/store.ts#Store]].

Events share a strict envelope of timestamp, source, kind, project, title, text, and metadata. Built-in kinds remain stable while custom kinds use the `x-` prefix.

## Ingest Pipeline

Every event follows validation, redaction, project resolution, narrow source-aware dedupe, and insertion in [[src/events.ts#ingestEvent]].

Redaction runs before database insertion. Workspace discovery retains `.env` key names while discarding bytes after `=`, allowing adjacent values to be redacted without retaining credentials.

Project attribution checks an explicit project, cwd prefix, repository remote, domain, and finally bounded configured keywords. Retry and failure events survive dedupe outside deliberately tiny windows.

## Capture Runtime

The daemon in [[src/daemon.ts#runDaemon]] watches the spool, runs due providers, records resource samples, and remains paused when an explicit pause window is active.

External emitters use [[src/spool.ts#spoolEvent]] so validated events reach disk safely. [[src/spool.ts#drainSpool]] recovers interrupted files, batches inserts, and quarantines rejected lines for review.

## Provider System

Built-in and custom collectors share health and cursor state through [[src/providers/index.ts#runProvider]]. One provider failure never stops unrelated capture.

Local collectors cover shell history, git reflogs and emit-on-change working-state metadata, bounded agent transcripts, Figma edit markers, saved asset metadata, and copy-then-read Chromium history. Cloud collectors use Keychain credentials.

Git working-state events record only branch, dirty-file count, ahead/behind counts, and stash depth. They never retain filenames, diffs, or file contents, and unchanged state does not emit another event.

ChatGPT uses a private import inbox because its desktop cache is encrypted and smer does not call a private conversation API. The daemon polls `~/.smer/imports/chatgpt` for changed official export ZIPs or `conversations.json`; Codex remains bounded local JSONL capture.

Figma polling reads recent-tab metadata from the desktop app's private `settings.json` and advances a per-file `editedAt` cursor. Events retain clean file/node links and timestamp metadata, but omit viewport state, session parameters, signed thumbnail URLs, and document contents. Missing or changed desktop state degrades to a warning because the schema is not a supported Figma API.

Asset polling uses filesystem metadata search under configured development roots. It records image paths, modification times, dimensions, sizes, and project attribution without storing image bytes, OCR, thumbnails, or visual embeddings.

Cursor creates one bounded event per completed Agent session and one lightweight event per saved project file found in its local-history indexes. Save events retain path and timestamp metadata but never read snapshot contents or diff bodies. Slack uses channel allowlists and independent timestamp cursors.

Custom providers use declarative API polling or JSONL tails where possible. Executables are the escape hatch and disable after five consecutive failures.

## Retrieval Surfaces

The CLI command router in [[src/cli.ts#main]] exposes source-aware search, timeline, stats, setup, provider control, imports, diagnostics, and ADR-001 JSON output.

The deterministic brief in [[src/brief.ts#buildBrief]] compares equal half-open windows, proposes bounded anomaly and open-loop candidates, and carries evidence event ids plus capture-health caveats in a versioned schema.

Running the binary without a command opens [[src/tui.ts#runTui]], a full-screen terminal search interface with event detail and source deep links.

`smer watch` opens a live terminal feed with daemon and provider health. The conditional pulse reports non-ambient events or health failures and persists its last window to avoid duplicate notifications.

## Agent Layer

Setup installs local digest, content-mining, workflow-retro, and provider-authoring prompts while keeping analysis inside the user's chosen agent subscription.

Analysis prompts begin with the deterministic brief and verify candidates against cited events.

Source-checkout installs link maintained command prompts into `~/.smer/commands` so updates become active immediately. Standalone binaries retain embedded copy fallback, and a valid existing link set is never replaced by fallback copies.

The bundled `smer` skill gives Codex and Claude Code one shared query workflow for evidence-backed synthesis, explicit inference, and event-id citations. A single repository-backed skill can be linked into both agents' global skill directories.

The bundled `add-smer-provider` skill documents adapter selection, Keychain credential handling, envelope mapping, verification, and health diagnosis.

## Privacy And Budgets

All state lives under `~/.smer` with private permissions, no telemetry, no screen capture, and no macOS TCC permissions.

Constitutional limits are under 100 MB daemon RSS, under 0.3 percent steady CPU, under 20 MB event writes per day, no timer below 60 seconds, under 5 seconds to search, and under 100 ms search at 100k events.

## Legacy Compatibility

The smer identity migration preserves existing corpora, custom providers, scripts, and credentials without requiring immediate downstream changes.

`SMEM_HOME`, `~/.smem`, `smem.db`, `smem-*` Keychain services, old shell-hook markers, and LaunchAgent labels are recognized as migration inputs. New installations, generated files, and agent skills use the smer identity.
