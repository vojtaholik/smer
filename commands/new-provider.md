# Add a smer provider

Inspect `smer providers --json` and the bundled `add-smer-provider` skill. Prefer a declarative API or JSONL provider; use an executable only when mapping cannot express the source. Keep credentials in Keychain, never config or `.env`. Validate a representative envelope with `smer emit --dry-run`, run one collection pass, retrieve the result with search, and finish with `smer doctor --json`.
