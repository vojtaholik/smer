# Add a smer provider

1. Inspect `smer providers --json` and the examples in the smer README.
2. Prefer a declarative `provider.toml` using api-poll or log-tail. Use an executable only when mapping cannot express the source.
3. Store cloud credentials in macOS Keychain, never in config or source.
4. Map every record to the strict event envelope: ts, source, kind, project, title, text, meta.
5. Test representative data with `smer emit --dry-run --json ...`.
6. Run `smer providers run ID --json`, then `smer doctor --json`.

Keep the provider reviewable on one screen. Preserve failures and retries as signal. Do not read .env values.
