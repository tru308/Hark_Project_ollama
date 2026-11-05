# Daily usage guide

A practical routine for coding with Claude Code on Ollama Cloud, with Ollama Guard keeping watch.

## Once: set it up (5 minutes)

```bash
npm install -g ollama-guard
ollama-guard init                 # key, model, fallback, alerts, status line
ollama-guard doctor               # everything green?
```

Make the Claude Code connection permanent so you never think about it again. The simplest
cross-platform way is Claude Code's own settings file, `~/.claude/settings.json`
(`%USERPROFILE%\.claude\settings.json` on Windows):

```bash
ollama-guard env --claude-json    # prints the "env" block to paste in
```

## Every morning

```bash
ollama-guard start --detach       # runs in the background, survives closing the terminal
ollama-guard status               # where am I? when does it reset?
```

Then just run `claude` as usual. The status line at the bottom of Claude Code shows:

```
Ollama 18% · resets 4h 05m · fallback: ready
```

> **Windows tip:** to start Guard automatically at login, press `Win + R`, type `shell:startup`, and
> create a shortcut with the target `cmd /c ollama-guard start --detach`.
>
> **macOS / Linux tip:** add `ollama-guard start --detach >/dev/null 2>&1` to your shell profile;
> it does nothing if Guard is already running.

## Reading the meter

| You see                | It means                                             | Do this                                                                           |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Green, under 70 %      | Plenty left                                          | Nothing. Code.                                                                    |
| Yellow, 70-90 %        | You've used most of this window                      | Batch big refactors; use plan mode; keep prompts focused.                         |
| Red, 90 %+             | Nearly out                                           | If downgrade is on, you're already on the cheaper model. Finish the current task. |
| `fallback: local (…)`  | Ollama said you're out; requests go to your fallback | Keep going. Expect a different (often smaller) model.                             |
| `Ollama Guard offline` | The proxy isn't running                              | `ollama-guard start --detach`                                                     |

Ollama shows usage as session and weekly limits on some plans, and as monthly included credits on
others. Guard shows whatever your account reports and always uses the fullest one for the status
line.

## Stretching your allowance

1. **Map background calls to a fast model.** Claude Code makes small "haiku" requests for titles,
   summaries and quick checks. Mapping them to a flash model saves real usage:
   `"models": { "map": { "claude-*": "glm-5.3", "claude-*haiku*": "glm-5.3-flash" } }`
2. **Turn on the downgrade at 85-90 %.** You keep working with less friction near the limit.
3. **Compact long sessions.** Use `/compact` in Claude Code when a conversation gets long; every
   request resends the whole context.
4. **Start fresh for new tasks.** `/clear` between unrelated tasks avoids paying for old context.
5. **Check projects in the dashboard.** If one project is eating your week, that's where to focus.

## When you hit a limit

- With a fallback configured, you'll get an alert ("Fallback active") and Claude Code carries on.
  When your window resets you get "Session limit reset" and Guard returns to Ollama automatically.
- Want to try Ollama again early (e.g. you bought extra credits)? Click **Try Ollama now** on the
  dashboard's Fallback tile.
- Without a fallback, Claude Code shows Ollama's error. You can wait for the reset (the meter shows
  exactly when), enable Ollama extra usage on your account, or add a fallback with `ollama-guard init`.

## Weekly check-in (2 minutes)

Open the dashboard (`ollama-guard dashboard`) and look at:

- **Last 14 days**: is usage creeping up? Any fallback days?
- **Projects**: which repos cost the most?
- **Models**: is most traffic on the model you meant to use?

## Keeping it healthy

```bash
ollama-guard doctor               # after updates, new machines, or anything odd
ollama-guard logs -n 20           # recent requests; add --follow to watch live
ollama-guard test-alert           # are notifications still reaching your phone?
npm update -g ollama-guard        # stay current
```

## On a shared or college lab machine

- Turn on `server.requireToken` (via `init`), so other users on the machine can't use your proxy.
- Prefer the OS keychain (`npm i -g keytar`, then choose it in `init`) over the secrets file.
- Run `ollama-guard stop` when you leave.
