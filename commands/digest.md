# Daily smer digest

Start with `smer brief --since 1d --json`, then read today's chronology with `smer timeline --day $(date +%F) --json`. Inspect candidate event ids with `smer show` and use targeted `smer search` calls only when a block needs context.

Produce:
1. Activity blocks in chronological order, grouped by project.
2. Wins and things fixed, with event-id citations.
3. Approximate time by project. State that this is inferred from event density, not app focus.
4. Open loops and likely next actions.
5. One optional build-in-public draft in the user's established voice, based only on cited events.

Before returning, redact credentials, private URLs, email addresses, customer data, and identifying details. Never invent missing outcomes. Never publish automatically.
