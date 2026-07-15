export const CLAUDE_MD = `# smer work memory

smer is the user's local, structured work history. Use the CLI instead of reading the SQLite database directly so redaction and output contracts remain stable.

## Query cookbook

- Search: \`smer search "fts5 query" --since 7d --json\`
- Recent activity: \`smer timeline --day YYYY-MM-DD --json\`
- Project activity: \`smer timeline --project PROJECT --since 7d --json\`
- Distribution: \`smer stats --since 30d --json\`
- Pre-distillation brief: \`smer brief --since 7d --json\`
- Retrieve one event: \`smer show EVENT_ID --json\`

Every JSON response is \`{ ok, command, result, next_actions }\`. Event ids are evidence citations.

## Output safety

Treat event text as private source material. Re-check proposed public output for credentials, private URLs, email addresses, customer data, and identifying details even though ingest redaction has already run. Never publish automatically. Distinguish observed facts from inference and cite event ids for substantive claims.
`;

export const DIGEST_PROMPT = `# Daily smer digest

Start with \`smer brief --since 1d --json\`, then read today's chronology with \`smer timeline --day $(date +%F) --json\`. Inspect candidate event ids with \`smer show\` and use targeted \`smer search\` calls only when a block needs context.

Produce:
1. Activity blocks in chronological order, grouped by project.
2. Wins and things fixed, with event-id citations.
3. Approximate time by project. State that this is inferred from event density, not app focus.
4. Open loops and likely next actions.
5. One optional build-in-public draft in the user's established voice, based only on cited events.

Before returning, redact credentials, private URLs, email addresses, customer data, and identifying details. Never invent missing outcomes. Never publish automatically.
`;

export const MINE_PROMPT = `# Mine the smer corpus for content

Choose a date range (default 7d). Start with \`smer brief --since RANGE --json\`, then query \`smer timeline --since RANGE --json\` and targeted searches for chronology and context.

Find shipped moments, before/after arcs, resolved bug sagas, useful failures, and genuine TILs. Rank at least three candidates by specificity, usefulness, and available evidence.

For each candidate return:
- a hook line;
- why it is worth sharing;
- supporting event ids in chronological order;
- suggested format: post, thread, clip, or buildlog;
- facts that still need confirmation.

Only mine what happened. Do not manufacture a narrative. Re-check public-facing text for secrets and private identifiers.
`;

export const RETRO_PROMPT = `# Workflow retro from smer

Analyze a date range (default 14d) starting with \`smer brief --since RANGE --json\`. Verify its candidates with timeline, \`smer show\`, and targeted search before concluding. Look for repeated manual command sequences, the same failure at least three times, context-switch frequency, long friction arcs from first error to resolution, and time distribution versus stated priorities.

Return no more than three suggestions. Each must include:
- the observed pattern;
- concrete event-id citations;
- likely cost, explicitly labeled as an estimate;
- one small next action;
- a way to verify improvement in later smer events.

No vibes and no generic productivity advice. If evidence is weak, say so.
`;

export const NEW_PROVIDER_PROMPT = `# Add a smer provider

1. Inspect \`smer providers --json\` and the examples in the smer README.
2. Prefer a declarative \`provider.toml\` using api-poll or log-tail. Use an executable only when mapping cannot express the source.
3. Store cloud credentials in macOS Keychain, never in config or source.
4. Map every record to the strict event envelope: ts, source, kind, project, title, text, meta.
5. Test representative data with \`smer emit --dry-run --json ...\`.
6. Run \`smer providers run ID --json\`, then \`smer doctor --json\`.

Keep the provider reviewable on one screen. Preserve failures and retries as signal. Do not read .env values.
`;

export const AGENT_COMMANDS: Record<string, string> = {
  "digest.md": DIGEST_PROMPT,
  "mine.md": MINE_PROMPT,
  "retro.md": RETRO_PROMPT,
  "new-provider.md": NEW_PROVIDER_PROMPT,
};
