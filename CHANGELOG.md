# Changelog

## 0.1.0 - 2026-11-02

- Initial release of webhook-replay-lab.
- Local HTTP server records webhook method, path, headers, and raw body as JSON files.
- CLI commands: `serve`, `list`, `show`, `replay`, `diff`, and `verify`.
- Signature checks for Stripe-Signature (HMAC-SHA256 with a timestamp tolerance) and shared-secret HMAC-SHA256 (`X-Hub-Signature-256`).
- Optional single-page web UI to browse captures, copy curl, and replay to a URL.
