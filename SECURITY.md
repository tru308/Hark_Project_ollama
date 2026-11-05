# Security

Ollama Guard handles API keys, so it is built to stay on your machine.

- Listens on `127.0.0.1` only by default, refuses unexpected `Host` headers (DNS rebinding) and
  foreign `Origin` headers (browser CSRF).
- Dashboard write endpoints require a custom header that cross-site pages cannot send.
- Optional proxy token (`server.requireToken`) for shared machines.
- Secrets are kept out of `config.json`, written atomically with mode `0600`, never returned by the
  dashboard API (only masked), and never logged. The OS keychain is available via `keytar`.
- Your Ollama key is only ever sent to `ollama.baseUrl`; fallback providers receive only their own
  key.
- Request logs contain metadata only (no prompts, no responses).

## Reporting a vulnerability

Please open a private security advisory on the repository (GitHub → Security → Advisories) rather
than a public issue. You'll get a reply within a few days.
