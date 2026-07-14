# Contributing to smer

Thanks for helping make private work memory more useful and trustworthy.

## Before you start

smer currently targets macOS and requires Bun 1.2 or newer. Install the
[`lat.md`](https://www.npmjs.com/package/lat.md) CLI before changing behavior or
architecture; the knowledge graph in `lat.md/` is part of the implementation.

For substantial changes, open an issue first so the behavior and privacy impact
can be discussed before code is written.

## Development workflow

1. Run `lat search` for the area you plan to change.
2. Add focused tests alongside the implementation.
3. Update the relevant `lat.md/` section when behavior, architecture, or test coverage changes.
4. Run the complete local gate:

```sh
bun test
bun run check
bun run benchmark
bun run build
lat check
```

Keep changes scoped and follow the patterns already present in the codebase.

## Privacy rules

Never commit a real smer database, captured event, transcript, browser history,
credential, provider response, project path, or generated digest. Tests should
use synthetic fixtures with unmistakably fake identities and secrets.

Any new capture provider must have bounded reads, pre-insert redaction,
source-aware deduplication, and a clear user-controlled enablement path. See the
`add-smer-provider` skill for the provider contract and verification workflow.

## Pull requests

Explain the user-facing change, privacy implications, and how you verified it.
Small pull requests are easier to review and safer to ship.
