# Architecture

Ollama Guard is one Node.js process with no native dependencies. It is a reverse proxy, a usage
poller, an alert engine and a small web app, sharing one in-memory runtime.

```
                       ┌───────────────────────── Ollama Guard (127.0.0.1:4141) ─────────────────────────┐
                       │                                                                                  │
 Claude Code ──HTTP──▶ │  server.ts  ── /v1/messages ──▶ proxy/forward.ts ──▶ proxy/plan.ts               │
  (ANTHROPIC_BASE_URL) │     │                              │   streams SSE      │ ordered attempts:       │
                       │     │                              │   tees usage       │ [Ollama Cloud, ...chain]│
                       │     │                              ▼                    ▼                         │
                       │     │                        logs/store.ts       runtime.ts (circuit state)       │
                       │     │                        daily JSONL                │                         │
                       │     ├── /dashboard ─────────▶ dashboard/index.html      │                         │
                       │     ├── /api/guard/* ───────▶ status, stats, logs, config, SSE events            │
                       │     └── /v1/messages/count_tokens → local estimate                               │
                       │                                                                                  │
                       │  usage/poller.ts ── every 60s ──▶ GET /api/balance + /api/usage (ollama.com)    │
                       │        │ normalize.ts → UsageSnapshot                                            │
                       │        ▼                                                                         │
                       │  alerts/engine.ts ── thresholds / resets ──▶ alerts/channels.ts                  │
                       │                                               desktop · Telegram · Discord       │
                       └──────────────────────────────────────────────────────────────────────────────────┘
```

## Modules

| Path                       | Responsibility                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`               | Entry point. Parses argv (`util/args.ts`) and dispatches to `commands/*`.                                                                                   |
| `src/config/schema.ts`     | Types, defaults, deep-merge, validation (incl. the one-account rule).                                                                                       |
| `src/config/store.ts`      | Reads/writes `config.json` and `secrets.json` (0600, atomic rename), optional keytar keychain.                                                              |
| `src/runtime.ts`           | `GuardRuntime`: holds config, secrets, usage snapshot, fallback circuit, alert history; emits `status` / `request` / `alert` events; persists `state.json`. |
| `src/server.ts`            | `node:http` server: security checks, routing, dashboard + JSON API + SSE.                                                                                   |
| `src/proxy/plan.ts`        | Pure function: given the requested model, config and state, returns the ordered upstream attempts with their model and auth headers. Also cost estimation.  |
| `src/proxy/forward.ts`     | Executes the plan: sends the request, decides fail-over, pipes the winning response through, records the log entry.                                         |
| `src/proxy/limits.ts`      | "Is this a quota/limit error?" classification.                                                                                                              |
| `src/proxy/sse.ts`         | Streaming tap that reads `message_start` / `message_delta` usage without altering bytes.                                                                    |
| `src/proxy/modelMap.ts`    | Glob model mapping (exact match, then most specific pattern).                                                                                               |
| `src/proxy/project.ts`     | Project attribution (header override, else Claude Code's "Working directory" line).                                                                         |
| `src/usage/client.ts`      | Bearer-authenticated calls to `/api/balance` and `/api/usage`.                                                                                              |
| `src/usage/normalize.ts`   | Converts every known response shape into a stable `UsageSnapshot`.                                                                                          |
| `src/usage/poller.ts`      | Fixed-cadence polling with Retry-After backoff and manual refresh throttling.                                                                               |
| `src/alerts/engine.ts`     | Pure threshold/reset logic with persisted de-duplication keys.                                                                                              |
| `src/alerts/channels.ts`   | node-notifier, Telegram Bot API, Discord webhooks. Never throws.                                                                                            |
| `src/logs/store.ts`        | Append-only JSONL per local day; in-memory aggregation for stats.                                                                                           |
| `src/statusline.ts`        | The one-line Claude Code status.                                                                                                                            |
| `src/dashboard/index.html` | The whole dashboard: HTML, CSS and vanilla JS in one file, no CDN.                                                                                          |

## Request lifecycle

1. **Security gate** (`server.ts`). Only `Host: 127.0.0.1|localhost:<port>` is served (blocks DNS
   rebinding). Any request with a foreign `Origin` is refused (blocks browser CSRF). Mutating
   dashboard calls also need the `x-ollama-guard: 1` header, which a cross-site page cannot send
   without a CORS preflight that Guard never approves. With `server.requireToken`, `/v1/*` needs the
   private proxy token (compared in constant time).
2. **Plan** (`plan.ts`). The requested model goes through `models.map`. If downgrade is on and the
   tightest usage window is above the threshold, `downgrade.map` swaps in the cheaper model. The
   attempt list is `[Ollama Cloud, ...enabled chain]`, or `[...chain, Ollama Cloud]` while the circuit
   is open. There is only ever one Ollama Cloud target, and validation rejects chain entries on
   `ollama.com`.
3. **Send** (`forward.ts`). Incoming headers are copied except hop-by-hop, auth, cookies and
   `Origin`; the target's own auth is added (`Authorization: Bearer <ollama key>` for Ollama Cloud,
   which does not accept `x-api-key` alone). `accept-encoding: identity` keeps the stream readable.
4. **Decide.** A non-2xx response body is read (errors are small). If it is a limit error from Ollama
   Cloud (`fallback.triggerStatuses`, or 400/403/503 whose text says limit/quota), the runtime opens
   the circuit and the next attempt runs. A failing fallback (5xx, 401, 404, limit) is skipped too.
   Any other error is relayed to Claude Code in Anthropic's error shape (Ollama's `{"error": "..."}`
   is converted), keeping `retry-after`.
5. **Stream.** The first 2xx response is written through chunk by chunk with back-pressure. The SSE
   tap reads token usage as it passes. If Claude Code disconnects, the upstream fetch is aborted.
6. **Record.** One `RequestLog` line is appended (no prompt or response content) and broadcast on the
   dashboard's SSE channel.

## The fallback circuit

```
            limit error from Ollama             fallback served → alert "Fallback active" (once)
 CLOSED ──────────────────────────────▶ OPEN ───────────────────────────────────────────────┐
   ▲                                     │ until = max(now + cooldownSec, Retry-After,      │
   │                                     │             window reset time if usage = 100%)   │
   └──── until passes · usage reset seen · Ollama answers OK · "Try Ollama now" ◀───────────┘
                                         (alert "Back on Ollama Cloud" if one was sent)
```

While open, Ollama Cloud stays in the plan as the last resort, so if every fallback fails the user
still gets Ollama's real error.

## Usage data

Ollama's account endpoints (docs.ollama.com, November 2026):

- `GET /api/balance`: current plans return `included.balance_usd`, `included.allowance_usd` and the
  monthly `period`; legacy plans return `included.session` / `included.weekly` with
  `remaining_percent` (0-100) and `resets_at`. Also `purchased.balance_usd` for extra-usage credits.
- `GET /api/usage?range=7d&group_by=model[&scope=team]`: history buckets with request counts,
  tokens and USD, per model.
- Both allow 10 requests/minute per user, shared across keys and devices; polling once a minute is
  recommended. A 429 carries `Retry-After`.

`normalize.ts` also accepts a `limits.session.usage` / `limits.weekly.usage` (0..1) object on the
usage response, a shape some users have reported. Every source becomes:

```ts
UsageSnapshot { windows: [{ id: 'session' | 'weekly' | 'monthly', used: 0..1, resetsAt? }], headline, purchasedUsd, today, models, ratePerToken }
```

`headline` (the fullest window) drives the status line, downgrade and circuit timing.

## Alerts

`AlertEngine.evaluate(next, prev)` is pure. For each window it:

1. detects a **reset** (reset time moved forward with usage lower, or usage fell by >25 points from an
   alert-worthy level), clears that window's fired keys and emits a reset alert;
2. finds thresholds crossed and not yet fired for `(window, reset period rounded to the hour,
threshold)`, and emits only the **highest**, so a jump from 50 % to 95 % sends one message.

Fired keys are saved in `state.json`, so restarts never re-alert.

## Storage

| File                             | Format          | Notes                                                                     |
| -------------------------------- | --------------- | ------------------------------------------------------------------------- |
| `config.json`                    | JSON            | No secrets; editable from the dashboard.                                  |
| `secrets.json`                   | JSON, mode 0600 | Or the OS keychain via optional `keytar`. `OLLAMA_API_KEY` env overrides. |
| `state.json`                     | JSON            | Snapshot, circuit, fired alert keys, recent alerts, pid, port.            |
| `logs/requests-YYYY-MM-DD.jsonl` | JSON Lines      | Retention-pruned on start.                                                |

JSONL rather than SQLite was a deliberate choice: no native module to compile on Windows, trivially
inspectable, and plenty fast for a single developer's volume (thousands of lines a day).

## Design choices

- **Zero native dependencies.** Only `node-notifier` at runtime (pure JS + bundled notifier
  binaries). Everything else is Node built-ins: `http`, global `fetch`, `readline`, `crypto`.
- **Fail open for logging and alerts, fail clear for requests.** A broken alert channel or log write
  never affects a request. A request that can't be served gets a precise Anthropic-shaped error.
- **No request rewriting beyond `model`.** Bodies are re-serialized with only the model changed, so
  tool use, thinking, images and future fields pass through untouched.
- **Local-only by default.** Binding, Host and Origin checks assume a single-user workstation.
