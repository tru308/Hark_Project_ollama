<div align="center">

# 🛡️ Ollama Guard

**A calm, local companion for Claude Code on Ollama Cloud.**
See your usage live, get a heads-up before you hit a limit, and keep coding when you do.

[![CI](https://github.com/tru308/Hark_Project_ollama/actions/workflows/ci.yml/badge.svg)](https://github.com/tru308/Hark_Project_ollama/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

</div>

```
 Claude Code ──▶  Ollama Guard (localhost:4141)  ──▶  Ollama Cloud
                   │  live usage meter                   │ 429 / 402?
                   │  alerts at 70 / 90 / 100 %          ▼
                   │  request log + dashboard       your fallback: local Ollama,
                   └  status line for Claude Code    OpenRouter or Anthropic (your keys)
```

```
╭─ Ollama Guard ──────────────────────────────────────────── ● Live ─╮
│                                                                    │
│   Good evening                                                     │
│   Plenty of room. Build something great.                           │
│                                                                    │
│     ╭───────╮        ╭───────╮       Account        personal       │
│    │  63 %   │      │  41 %   │      Extra credits  $5.00          │
│    │ SESSION │      │ WEEKLY  │      Updated        9:41 PM        │
│     ╰───────╯        ╰───────╯                                     │
│   Resets in 2h 10m  Resets in 3d 5h                                │
│                                                                    │
│   Requests today 84 · Tokens 1.9M · Est. cost $0.36 · Fallback ⇄ Ready
│                                                                    │
│   Last 14 days  ▂▃▅▇▆▃▂▅▆▇█▅▃▆      Projects  corpverse ███████▏   │
╰────────────────────────────────────────────────────────────────────╯
 Claude Code status line:   Ollama 63% · resets 2h 10m · fallback: ready
```

> Screenshots: run `ollama-guard start --open` and the real dashboard opens at
> `http://127.0.0.1:4141/dashboard`. (Real PNGs can be dropped into `docs/images/`.)

---

## Why

Claude Code works beautifully with Ollama's cloud models, but the plan limits are invisible until a
request suddenly fails mid-task. Ollama Guard sits quietly between the two and makes that visible:

- **Know where you stand.** A live meter of your Ollama usage and exactly when it resets, in a
  dashboard, in your terminal, and right inside Claude Code's status line.
- **Hear about it early.** Desktop, Telegram or Discord alerts at 70 %, 90 % and 100 %, and a
  friendly "you're back" when the limit resets.
- **Keep working.** When Ollama says you're out of quota, Guard retries the same request on a
  fallback you choose (local models on your own machine, or a provider you pay for) without
  Claude Code noticing. Optionally it switches to a cheaper model before you get there.
- **See what you used.** Tokens and estimated cost per day, per project and per model, from a
  local request log. Prompts and responses are never stored.

## One account, by design

> [!IMPORTANT]
> Ollama Guard supports **exactly one Ollama account and one API key** (if you belong to an
> Ollama team, it can show the team's usage with that same key). It does **not** rotate keys or
> accounts and will never switch Ollama accounts to get around a quota. The config validator
> rejects any fallback that points at `ollama.com`.
>
> Fallback only goes to legitimate alternatives you run or pay for yourself: **local Ollama models**,
> **Ollama extra usage** (pay-as-you-go credits on your own account), or **another provider with
> your own key** (OpenRouter, Anthropic, or any Anthropic-compatible gateway).

---

## 2-minute quick start

You need **Node.js 20.10+** ([nodejs.org](https://nodejs.org)), **Claude Code**, and an
**Ollama API key** from [ollama.com/settings/keys](https://ollama.com/settings/keys).

### Windows (PowerShell)

```powershell
# 1. Install (clone, build, and put `ollama-guard` on your PATH)
git clone https://github.com/tru308/Hark_Project_ollama.git
cd Hark_Project_ollama
npm install
npm run build
npm link

# 2. Set up (paste your key when asked; takes about a minute)
ollama-guard init

# 3. Start the guard in the background and open the dashboard
ollama-guard start --detach --open

# 4. Point Claude Code at the guard, in the same PowerShell window
ollama-guard env --shell powershell | Invoke-Expression
claude
```

To make step 4 permanent for every new window, either add the `env` block to
`%USERPROFILE%\.claude\settings.json` (`ollama-guard env --claude-json` prints it), or run:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://127.0.0.1:4141", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "ollama-guard", "User")
```

### macOS / Linux (bash or zsh)

```bash
git clone https://github.com/tru308/Hark_Project_ollama.git
cd Hark_Project_ollama
npm install && npm run build && npm link   # use sudo npm link if your npm needs it
ollama-guard init
ollama-guard start --detach --open

eval "$(ollama-guard env)"      # this terminal only
claude

# make it permanent
ollama-guard env --shell zsh >> ~/.zshrc     # or: --shell bash >> ~/.bashrc
```

> Prefer not to link globally? From the repo folder, `node dist/cli.js init` and `node dist/cli.js start` work too.
> To update later: `git pull && npm install && npm run build`.
> From a clone: `npm install && npm run build && npm link`.

Check everything with:

```bash
ollama-guard doctor
```

---

## What you get

|                           |                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transparent proxy**     | Forwards the Anthropic Messages API, including SSE streaming, tool use, thinking and images. Swaps in your Ollama key so it never lives in Claude Code's environment.                                                     |
| **Live usage meter**      | Polls Ollama's account API every 60 s (the documented recommendation; the API allows 10 req/min). Shows session / weekly or monthly-credit usage with reset countdowns.                                                   |
| **Alerts**                | Thresholds (default 70/90/100 %), reset, fallback on/off. Desktop notifications (Windows toast, macOS Notification Center, Linux notify-send), Telegram bot, Discord webhook. Never repeats an alert for the same window. |
| **Smart fallback**        | On 429 / 402 / quota errors, retries the same request on your fallback chain. Remembers that Ollama is limited and goes straight to the fallback until your window resets.                                                |
| **Pre-emptive downgrade** | Above a threshold (default 90 %), quietly maps e.g. `glm-5.3 → glm-5.3-flash` to stretch what's left.                                                                                                                     |
| **Model mapping**         | Glob rules such as `claude-*haiku* → glm-5.3-flash` so Claude Code's background "haiku" calls use a fast cloud model.                                                                                                     |
| **Dashboard**             | `http://127.0.0.1:4141/dashboard`: usage rings, 14-day chart, per-project and per-model breakdowns, live request log, alerts, settings editor. Light and dark, fully self-contained (no CDN).                             |
| **Status line**           | `Ollama 63% · resets 2h 10m · fallback: ready` inside Claude Code.                                                                                                                                                        |
| **CLI**                   | `init`, `start`, `stop`, `status`, `logs`, `doctor`, `env`, `statusline`, `test-alert`, `dashboard`, `config`.                                                                                                            |

## Commands

```text
ollama-guard init                    Interactive setup wizard
ollama-guard init --yes              Non-interactive (uses OLLAMA_API_KEY)
ollama-guard start [--port 4141] [--open] [--detach]
ollama-guard stop                    Stop a background (--detach) guard
ollama-guard status [--json]         Usage bars, resets, fallback state, today's totals
ollama-guard logs [-n 50] [--follow] [--json]
ollama-guard doctor                  Key, connectivity, Claude Code env, fallback health
ollama-guard env [--shell bash|zsh|fish|powershell|cmd] [--claude-json]
ollama-guard statusline [--install] [--no-color]
ollama-guard test-alert              Send a test notification to every enabled channel
ollama-guard dashboard               Open the dashboard in your browser
ollama-guard config path|show
```

### Claude Code status line

```bash
ollama-guard statusline --install     # adds statusLine to ~/.claude/settings.json (backup kept)
```

Or add it yourself:

```json
{ "statusLine": { "type": "command", "command": "ollama-guard statusline", "padding": 0 } }
```

It answers in well under a second, and falls back to the last saved state if the guard is busy.

---

## Configuration

Everything lives in `~/.ollama-guard/` (`%USERPROFILE%\.ollama-guard\` on Windows):

| File                             | What                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `config.json`                    | Settings below. Safe to share; contains no secrets.                                |
| `secrets.json`                   | Ollama key, alert tokens, fallback provider keys. Owner-only permissions (`0600`). |
| `state.json`                     | Last usage reading, alert history, fallback state (for the status line).           |
| `logs/requests-YYYY-MM-DD.jsonl` | One line per request: model, provider, tokens, cost, latency. No prompt text.      |

Edit it in the dashboard (Settings), with `ollama-guard init`, or by hand. A full example is in
[`examples/config.example.json`](examples/config.example.json).

| Key                                              | Default                      | Meaning                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host` / `server.port`                    | `127.0.0.1` / `4141`         | Where the proxy and dashboard listen. Keep it on localhost.                                                                                                    |
| `server.requireToken`                            | `false`                      | Require Claude Code to send the private proxy token (`env` prints it).                                                                                         |
| `server.localCountTokens`                        | `true`                       | Answer `/v1/messages/count_tokens` locally (Ollama doesn't implement it).                                                                                      |
| `ollama.baseUrl`                                 | `https://ollama.com`         | Ollama Cloud.                                                                                                                                                  |
| `ollama.usageScope`                              | `self`                       | `team` shows your team's total (team admins). Same single key.                                                                                                 |
| `ollama.accountLabel`                            | `personal`                   | Display name only.                                                                                                                                             |
| `ollama.pollIntervalSec`                         | `60`                         | Usage refresh interval. Minimum 15.                                                                                                                            |
| `ollama.requestTimeoutSec`                       | `600`                        | Max time for one generation.                                                                                                                                   |
| `models.map`                                     | `{}`                         | Glob map from requested model to Ollama model, e.g. `{"claude-*": "glm-5.3"}`.                                                                                 |
| `fallback.enabled`                               | `false`                      | Turn the fallback chain on.                                                                                                                                    |
| `fallback.triggerStatuses`                       | `[429, 402]`                 | Ollama statuses that trigger fallback. 403/400/503 also trigger when the body clearly says "limit"/"quota".                                                    |
| `fallback.onNetworkError`                        | `false`                      | Also fall back when ollama.com is unreachable.                                                                                                                 |
| `fallback.cooldownSec`                           | `300`                        | Minimum time to stay on the fallback after a limit hit (extended to your reset time when usage shows 100 %).                                                   |
| `fallback.chain[]`                               | `[]`                         | Providers tried in order. See below.                                                                                                                           |
| `downgrade.enabled` / `thresholdPercent` / `map` | `false` / `90` / `{}`        | Pre-emptive cheaper model.                                                                                                                                     |
| `alerts.thresholds`                              | `[70, 90, 100]`              | Percentages.                                                                                                                                                   |
| `alerts.onReset` / `onFallback`                  | `true`                       | Extra alerts.                                                                                                                                                  |
| `alerts.desktop`                                 | `true`                       | Native notifications.                                                                                                                                          |
| `alerts.telegram`                                | `{enabled:false, chatId:""}` | Token lives in secrets.                                                                                                                                        |
| `alerts.discord`                                 | `{enabled:false}`            | Webhook lives in secrets.                                                                                                                                      |
| `pricing`                                        | `{}`                         | `"modelGlob"` or `"provider::modelGlob"` → `{inputPerMTok, outputPerMTok}` USD. Without it, Ollama costs are estimated from Ollama's own per-model usage data. |
| `logging.retentionDays`                          | `30`                         | Old log files are deleted on start.                                                                                                                            |
| `secretStore`                                    | `file`                       | `keychain` uses the OS keychain if you `npm i -g keytar`.                                                                                                      |

Environment overrides: `OLLAMA_API_KEY` (takes precedence over the stored key),
`OLLAMA_GUARD_HOME` (move the whole folder), `NO_COLOR`.

### Fallback provider fields

| Field                       | Notes                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | Your label, also used to look up its key in `secrets.json → providers`.                                                                                       |
| `type`                      | `ollama-local`, `openrouter`, `anthropic`, or `anthropic-compatible`.                                                                                         |
| `baseUrl`                   | Defaults: local `http://localhost:11434`, OpenRouter `https://openrouter.ai/api`, Anthropic `https://api.anthropic.com`. Required for `anthropic-compatible`. |
| `authStyle`                 | `bearer`, `x-api-key` or `none` (defaults per type).                                                                                                          |
| `apiKeyEnv`                 | Read the key from an environment variable instead of `secrets.json`.                                                                                          |
| `modelMap` / `defaultModel` | How Claude Code's model name becomes this provider's model.                                                                                                   |

## Fallback recipes

**Local models on your laptop (free, offline).** Install [Ollama](https://ollama.com/download),
pull a coding model with tool support, give it a large context (64k+ is recommended for Claude Code):

```bash
ollama pull qwen3-coder
```

```json
"fallback": {
  "enabled": true,
  "chain": [{ "name": "local", "type": "ollama-local", "defaultModel": "qwen3-coder" }]
}
```

**OpenRouter (your own key).**

```json
"fallback": {
  "enabled": true,
  "chain": [{ "name": "openrouter", "type": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY",
              "defaultModel": "anthropic/claude-sonnet-4.5" }]
}
```

**Anthropic API (your own key), with model mapping.**

```json
{ "name": "anthropic", "type": "anthropic", "modelMap": { "claude-*haiku*": "claude-haiku-4-5", "*": "claude-sonnet-4-5" } }
```

Put its key in `secrets.json` as `"providers": { "anthropic": "sk-ant-…" }`, or use `apiKeyEnv`.

**Belt and braces:** list several; Guard tries them in order and skips a broken one.

**Ollama extra usage (pay-as-you-go).** This is not a fallback entry: turn on extra usage for your
account at ollama.com and Ollama keeps serving past your plan limit from purchased credits. Guard
shows your purchased balance in the dashboard and still alerts at your thresholds.

**Downgrade before you run out:**

```json
"downgrade": { "enabled": true, "thresholdPercent": 90, "map": { "glm-5.3": "glm-5.3-flash" } }
```

## Telegram alerts

1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts, copy the **token**.
2. Open your new bot and send it any message (this lets it message you back).
3. Run `ollama-guard init` and say yes to Telegram. Guard finds your chat id automatically and
   sends a test message.

Manual setup: put the token in `secrets.json` as `telegramBotToken`, then get your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates` (`result[].message.chat.id`) and set
`alerts.telegram = { "enabled": true, "chatId": "<id>" }`. Test with `ollama-guard test-alert`.

**Discord:** Server Settings → Integrations → Webhooks → New Webhook → Copy URL. Save it as
`discordWebhookUrl` (via `init` or the dashboard) and enable `alerts.discord`.

---

## Troubleshooting

| Symptom                                                          | Fix                                                                                                                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code still talks to Anthropic / asks you to log in        | `ANTHROPIC_BASE_URL` didn't reach it. Run `ollama-guard doctor`. Values in `~/.claude/settings.json → env` override your shell. Run `/status` inside Claude Code to see the base URL it uses. |
| `401` from the guard                                             | `server.requireToken` is on: use the token from `ollama-guard env`.                                                                                                                           |
| `401 invalid credentials` from Ollama                            | Your key is wrong or revoked. Create a new one and rerun `ollama-guard init`.                                                                                                                 |
| Usage shows "unavailable"                                        | The usage API may be rate limited (shared 10 req/min per user across devices). Guard backs off automatically. `doctor` shows the exact error.                                                 |
| `Port 4141 is busy`                                              | `ollama-guard start --port 4142`, then rerun `ollama-guard env`.                                                                                                                              |
| No desktop notifications on Windows                              | Check Focus Assist / Do Not Disturb. Toasts come from SnoreToast via `node-notifier`.                                                                                                         |
| No notifications on Linux                                        | Install `libnotify-bin` (`notify-send`).                                                                                                                                                      |
| Fallback never triggers                                          | Is `fallback.enabled` true and the chain non-empty? `doctor` checks each provider. Only limit errors trigger it, not ordinary bad requests.                                                   |
| Local fallback is slow or forgets context                        | Give the local model a bigger context window (64k+) and pick a model with tool support.                                                                                                       |
| Tools fail on a fallback model                                   | Not every model supports tool calling well. Choose one with "tools" capability.                                                                                                               |
| PowerShell says scripts are disabled when running `ollama-guard` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `ollama-guard.cmd`.                                                                                                             |

## FAQ

**Is this allowed? Does it get around Ollama's limits?**
No, and it is built not to. It uses one account and shows you that account's limits. When you hit
one, it moves your work to something else you're entitled to use (your machine, or your own paid
key elsewhere). It never uses a second Ollama account.

**Can I use my Ollama team?**
Yes. If you're a team admin, set `ollama.usageScope` to `team` to see the team's total. Team members
share balances, so the meter reflects the team's credits. It's still one key.

**Does it store my prompts or code?**
No. The log records metadata only (time, model, provider, tokens, cost, latency, project folder
name). Nothing leaves your machine except the requests themselves, to the provider handling them.

**Where does the "project" name come from?**
Claude Code's system prompt includes its working directory; Guard keeps only the folder name. You
can override it with `ANTHROPIC_CUSTOM_HEADERS="x-ollama-guard-project: my-app"`.

**How accurate is the cost?**
For Ollama Cloud, Guard derives a per-model rate from Ollama's own usage API and applies it to
each request's tokens: a good estimate, not an invoice. For other providers, add a `pricing` entry.
Your Ollama account page remains the source of truth.

**Does it slow Claude Code down?**
Negligibly: streams are piped through byte-for-byte as they arrive, on localhost.

**Can other devices use it?**
It binds to `127.0.0.1` and rejects foreign `Host`/`Origin` headers on purpose. Keep it that way.

**Does it work in WSL?**
Yes. Run Guard and Claude Code on the same side (both in WSL, or both on Windows).

## Development

```bash
git clone https://github.com/tru308/Hark_Project_ollama.git && cd Hark_Project_ollama
npm install
npm run build && npm test     # vitest: proxy routing, fallback, alerts, usage parsing
npm run lint && npm run typecheck
node scripts/mock-ollama.mjs  # fake Ollama Cloud on :11500 for demos (no key needed)
```

See [docs/architecture.md](docs/architecture.md) and [docs/daily-usage-guide.md](docs/daily-usage-guide.md).

## License

[MIT](LICENSE). Not affiliated with Ollama or Anthropic. "Claude" and "Claude Code" are
trademarks of Anthropic; "Ollama" is a trademark of Ollama Inc.
