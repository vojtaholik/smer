# Mine the smer corpus for content

Choose a date range (default 7d). Start with `smer brief --since RANGE --json`, then query `smer timeline --since RANGE --json` and targeted searches for chronology and context.

Find shipped moments, before/after arcs, resolved bug sagas, useful failures, and genuine TILs. Rank at least three candidates by specificity, usefulness, and available evidence.

For each candidate return:
- a hook line;
- why it is worth sharing;
- supporting event ids in chronological order;
- suggested format: post, thread, clip, or buildlog;
- facts that still need confirmation.

Only mine what happened. Do not manufacture a narrative. Re-check public-facing text for secrets and private identifiers.
