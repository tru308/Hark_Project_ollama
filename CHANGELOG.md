# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-05

### Added

- Transparent local proxy for the Anthropic Messages API (`/v1/messages`) with SSE streaming,
  tool use, thinking and image passthrough; generic passthrough for other paths.
- Local answer for `/v1/messages/count_tokens`, which Ollama does not implement.
- Live usage meter polling Ollama's `/api/balance` and `/api/usage` every 60 s, with Retry-After
  backoff; supports current-plan monthly credits, legacy session/weekly limits and a
  `limits.*.usage` shape.
- Alerts at configurable thresholds (default 70/90/100 %), on reset, and on fallback activation,
  via desktop notifications, Telegram and Discord, de-duplicated across restarts.
- Fallback chain on 429/402/quota errors to local Ollama, OpenRouter, Anthropic or any
  Anthropic-compatible endpoint, with a circuit that waits for the usage window to reset.
- Pre-emptive downgrade to a cheaper model above a usage threshold; glob model mapping.
- Self-contained dashboard at `/dashboard`: usage rings, reset countdowns, 14-day chart,
  per-project and per-model stats, live request log, alerts, settings editor, light/dark themes.
- Claude Code status line (`ollama-guard statusline`, `--install`).
- CLI: `init`, `start` (`--detach`), `stop`, `status`, `logs` (`--follow`), `doctor`, `env`
  (bash/zsh/fish/PowerShell/cmd/Claude settings JSON), `test-alert`, `dashboard`, `config`.
- Single-account guarantee: config validation rejects fallbacks pointing at ollama.com.
- Local hardening: Host and Origin checks, custom-header requirement for dashboard writes,
  optional proxy token, 0600 secrets file, optional OS keychain via keytar.
- Vitest suite, ESLint + Prettier, GitHub Actions CI on Windows, macOS and Linux.
