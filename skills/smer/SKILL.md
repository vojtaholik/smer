---
name: smer
description: Query and analyze the user's private smer work-memory corpus. Use for daily or weekly digests, project status, open loops, decision reconstruction, Slack-to-code connections, shipped-work summaries, content mining, workflow retrospectives, recurring friction, time-distribution estimates, or any question about what the user recently worked on.
---

# Query smer Work Memory

Use the `smer` CLI to turn captured work events into evidence-backed answers. Never read `~/.smer/smer.db` directly.

## Query Workflow

1. Confirm that `smer` is available. If a command fails, run `smer doctor --json` and explain the relevant failure.
2. Infer the smallest useful date range and project scope from the request. Default to 7 days for discovery, today for a daily digest, and 14 days for a workflow retro.
3. Establish breadth with `smer brief --since RANGE --json`. Treat its anomalies and open loops as candidates, not conclusions, and note every coverage caveat.
4. Establish chronology with `smer timeline --since RANGE --json` when the question needs it, then run focused searches with `smer search "FTS5 QUERY" --since RANGE --json`. Add `--project PROJECT`, `--source SOURCE`, or `--kind KIND` when useful.
5. Inspect decisive evidence with `smer show EVENT_ID --json`. Do not base a strong conclusion only on a truncated search result.
6. Synthesize the answer around the user's question. Cite substantive observed claims as `[#EVENT_ID]`, distinguish inference from observation, and state where evidence is incomplete.

Keep tool output compact. Narrow the range or query instead of dumping a large timeline into the conversation.

## Investigation Modes

### Digest

Group activity chronologically by project. Identify wins, fixes, open loops, and likely next actions. Estimate project time only from event density and label it as an estimate, never as tracked focus time.

### Mine Interesting Material

Look for shipped moments, before/after arcs, resolved bug sagas, useful failures, surprising cross-tool connections, and genuine lessons. Rank candidates by specificity, usefulness, and evidence quality. Include facts that still need confirmation.

### Workflow Retro

Look for repeated command sequences, the same failure at least three times, frequent project switching, long friction arcs, and effort that appears misaligned with stated priorities. Return at most three recommendations, each with evidence, estimated cost, one small experiment, and a future smer signal that would verify improvement.

### Decisions And Open Loops

Search terms such as `decision`, `decided`, `TODO`, `follow up`, `blocked`, `later`, and project-specific vocabulary. Connect Slack discussion to later agent, shell, git, or deployment events when the chronology supports it. Treat an apparent connection as inference unless an event explicitly states it.

### Project Reconstruction

Use `smer projects list --json` to resolve project names when needed. Build a chronological narrative from the first relevant problem signal through implementation and outcome. Do not claim completion without a confirming event.

## Query Guidance

- Use FTS5 operators such as `term1 OR term2` and quoted phrases such as `"exact phrase"`.
- Search Slack with `--source slack --kind x-slack-message`. Search an agent with `--source chatgpt|claude-code|codex|cursor --kind agent_session`; source names are filters, not FTS terms.
- Use `--source cursor --kind x-file-edit` to connect files saved in Cursor with nearby git, shell, and agent events. These events contain paths and timestamps, never file contents.
- Use several small searches with synonyms when the user's language may differ from event text.
- If results are empty, broaden the date range, remove filters, inspect `smer providers --json`, and report corpus gaps rather than inventing an answer.
- Prefer chronological event IDs for a narrative and ranked event IDs for recommendations.

## Privacy And Accuracy

Treat every event as private source material. Before returning public-facing copy, remove credentials, private URLs, email addresses, customer data, and identifying details even if ingest redaction already ran. Never publish or send anything automatically.

Do not manufacture causality, outcomes, time tracking, or narrative coherence. Separate sections labeled `Observed`, `Inferred`, and `Unknown` when that distinction materially improves the answer.
