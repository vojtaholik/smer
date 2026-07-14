# Distillation Roadmap

Plan for growing smer from a capture substrate into a distillation pipeline: richer context capture, a deterministic brief, an agent loop that writes observations back into the corpus, and a newspaper-style re-entry page.

The goal is re-entry, not reporting: surface open loops with continuation prompts so work can be picked back up quickly. smer keeps its constitution — no LLM calls, no telemetry, local-first per [[architecture#Privacy And Budgets]] — and judgment stays in the user's own agent per [[architecture#Agent Layer]].

## Design Stance

Four principles shape every phase: corpus in code and judgment in agent, compute surprise not description, make artifacts executable, and gain privacy from network boundaries instead of from never publishing.

- **Substrate and consumer.** smer captures and serves facts; the distillation loop is a consumer built on `--json` output and [[src/spool.ts#spoolEvent]] writeback. Renderers and publishers stay thin and replaceable.
- **Numbers propose, the agent disposes.** Deterministic statistics generate anomaly candidates with event-id pointers; the agent selects, interprets, and cites. Averages produce horoscopes; anomalies produce observations.
- **Executable artifacts.** Every open loop ships with a continuation prompt that can be pasted into an agent session to resume the work.
- **Privacy by network.** Pages are generated locally and served inside a private network boundary (for example a tailnet). smer itself never uploads anything.

## Phase 1: Richer Capture

New signals are admitted by one test: does the signal help detect an open loop, explain a failure, or connect work to an outcome? Raw volume fails this test; state and intent pass it.

### Git Working State

A per-project scan of branch, dirty file count, ahead/behind counts, and stash depth, emitting an event only on change. This is the highest-value open-loop signal and needs no permissions beyond what [[src/providers/workspace.ts#scanWorkspaces]] already uses.

Snapshot events use an `x-git-state` kind with cwd metadata so project attribution works unchanged. Emit-on-change keeps write budgets flat, and the resulting events read like re-entry sentences: branch, uncommitted files, unpushed commits, days untouched.

### GitHub Waiting On Me

Invert the GitHub provider's view: open pull requests, reviews requested from the user, and failing checks on the user's branches, alongside the existing activity feed polled by [[src/providers/cloud.ts#pollCloudProvider]].

These events feed the "waiting on me" section of the brief. Same Keychain token and cursor discipline, additional read-only endpoints.

### Failed Command Stderr Tail

An opt-in upgrade to the shell hook installed by [[src/setup.ts#shellHookSnippet]]: capture a bounded stderr tail (about 2 KB) only when the exit code is nonzero, passed through [[src/events.ts#redactText]] before insertion.

Failure streaks become diagnosable stories instead of bare counts. This stays opt-in because command output is the riskiest text smer can store; the default remains metadata-only capture.

### Provider Hint Learning

Widen [[src/providers/workspace.ts#PROVIDER_HINTS]] beyond Vercel, GitHub, Inngest, and fal to recognize outcome services observed in project env key names: Stripe, Mux, Deepgram, Resend, Postmark, Sanity, PostHog, PlanetScale.

Ship declarative custom-provider templates for the outcome-marking services (sale completed, asset ready, transcript done, broadcast sent) so a workspace suggestion can be accepted in one command. smer learns what context each workspace produces from the workspace itself.

### Browser Search Queries

Extract the search query from search-engine URLs the browser provider already harvests, storing it in event text so research intent is searchable and attributable to the work that followed it.

Deterministic, no new sources, and the existing domain denylist is untouched.

### Vercel Failure Context

When a deployment ends in error, fetch a bounded tail of build log text so the corpus records why a deploy failed, not only that it failed.

## Phase 2: The Brief

`smer brief --since 7d --json` is a deterministic pre-distillation report: an agent briefing packet of deltas, anomalies, and candidates, every item carrying event ids for drill-down and citation. No LLM is involved.

The brief compresses an unreadable volume of raw events into a few kilobytes of facts plus pointers, so the agent spends its context on the interesting threads. Its contract:

- **Deltas, not totals** — per project and source versus the prior equal window: surges, silences, first appearances, and reawakenings after quiet periods.
- **Bursts** — top activity blocks from the [[src/query.ts#timeline]] clustering, with span, project, and representative event ids.
- **Failure signals** — exit-code streaks, same-title repeated failures, and retry clusters; the dedupe design deliberately preserves these events.
- **Outcome events verbatim** — deploys, failed jobs, and future outcome-provider events, included raw because they are rare.
- **Cross-system matrix** — project-by-source counts, the data behind a projects register page.
- **Open-loop candidates** — cheap heuristics only, such as a burst ending on an unresolved failure or the last event per active project; the agent judges which candidates are real.
- **Coverage caveats** — pause markers, provider health, and daemon heartbeat, so the agent never distills a capture gap into an insight.

Existing aggregation in [[src/query.ts#stats]] remains; the brief builds on it rather than replacing it. Prompts that currently ask the agent to detect patterns across raw events delegate that work to the brief.

## Phase 3: Distillation Loop

A recurring agent tick turns the brief into durable knowledge: launchd runs the user's agent with a sweep prompt; the agent reads the brief, drills into candidates, and writes results back into the corpus through the spool.

### Observation Writeback

Distillations are corpus events: `x-observation`, `x-open-loop`, and `x-decision` kinds emitted via `smer emit --spool`, each citing the event ids that support it.

The corpus becomes self-distilling: observations land through the same validation and redaction as raw events in [[src/events.ts#ingestEvent]], are FTS-searchable beside them, and let end-of-day rollups supersede the day's noise without deleting it.

### Sweep Automation

`smer automation sweep` installs a LaunchAgent on a StartInterval, following the existing pattern of [[src/setup.ts#installDigestAutomation]]. The capture daemon in [[src/daemon.ts#runDaemon]] is untouched; the tick is a separate, disposable process whose failures never affect capture.

### Prompt Updates

`digest.md` and `retro.md` begin with the brief instead of raw timelines, shedding pattern-detection duties that belong in SQL.

A new `sweep.md` prompt defines the loop: read the brief, verify candidates against the corpus, write observations and open loops with continuation prompts, refresh the page.

## Phase 4: The Edition

A newspaper-format static page generated from the corpus for re-entry: open loops with continuation prompts on the front page, recent observations, a projects register across all sources, and a capture-health box.

The renderer is deliberately dumb — it queries recent `x-observation` and `x-open-loop` events and formats them; all judgment already happened in the sweep. Output is self-contained HTML under `~/.smer` with private permissions, served inside a private network (for example `tailscale serve`) or shared ephemerally by explicit user action. smer never publishes on its own.

## Non-Goals

Boundaries that keep the constitution meaningful while the surface area grows.

- No calendar, email, or message capture that requires macOS TCC permissions.
- No app focus or idle tracking; event density remains the honest time proxy.
- No LLM calls inside smer; distillation runs in the user's agent subscription.
- No automatic publishing to any network destination.
- No herdr or other multiplexer integration until such a tool is part of the daily workflow.

## Sequencing

Ship thin vertical slices, each landing with lat.md sections, test specs, and budget verification before the next begins.

1. **M1 — Brief plus git working state.** Highest value for least effort; makes every existing consumer smarter immediately.
2. **M2 — Sweep loop.** Writeback conventions, sweep prompt, launchd automation, digest and retro prompt updates.
3. **M3 — The edition.** Front page, projects register, health box, private-network serving recipe.
4. **M4 — Outcome capture.** GitHub waiting-on-me, provider hint learning with templates, stderr tails, Vercel failure context, browser search queries.

Success is behavioral, not architectural: the page gets opened to resume real work, and observations cite real evidence. If the M1 brief does not visibly improve digests, stop and rethink before building M2.
