# Contributing

Thanks for helping make Ollama Guard better.

## Setup

```bash
npm install
npm run build
npm test
```

Useful while developing:

```bash
node scripts/mock-ollama.mjs            # fake Ollama Cloud on :11500 (no key needed)
OLLAMA_GUARD_HOME=/tmp/og node dist/cli.js start
```

Point a throwaway config at the mock with `"ollama": { "baseUrl": "http://127.0.0.1:11500" }`.

## Ground rules

- **One Ollama account.** Pull requests that add multiple Ollama keys, account rotation, or any
  mechanism that switches Ollama accounts to avoid quotas will not be accepted.
- Keep runtime dependencies near zero and avoid native modules (Windows users matter).
- Never log prompt or response content.
- Add or update tests for behaviour changes (`test/`), and run `npm run lint && npm run typecheck`.
- Update `CHANGELOG.md` under "Unreleased".

## Commit style

Short imperative subject lines with a conventional prefix, e.g. `feat: …`, `fix: …`, `docs: …`.
