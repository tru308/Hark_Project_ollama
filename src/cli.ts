#!/usr/bin/env node
import { paths } from './config/paths.js';
import { ConfigError, defaultConfig } from './config/schema.js';
import { configExists, loadConfig, loadSecrets } from './config/store.js';
import { dispatchAlert } from './alerts/channels.js';
import { runDoctor } from './commands/doctor.js';
import { runEnv } from './commands/env.js';
import { runInit } from './commands/init.js';
import { runLogs } from './commands/logs.js';
import { runStart, runStop } from './commands/start.js';
import { installStatusline, runStatus, runStatusline } from './commands/status.js';
import { fetchStatus, guardUrl, openInBrowser } from './util/system.js';
import { banner, c, sym } from './util/term.js';
import { VERSION } from './version.js';
import { parseArgs } from './util/args.js';

const HELP = `${banner('a calm proxy between Claude Code and Ollama Cloud')}
  ${c.bold('Usage')}  ollama-guard <command> [options]

  ${c.bold('Commands')}
    init                 Interactive setup (key, model, fallback, alerts)
    start                Run the proxy + dashboard   ${c.gray('--port 4141 --open --detach')}
    stop                 Stop a background guard
    status               Usage, resets, fallback state   ${c.gray('--json')}
    logs                 Recent requests   ${c.gray('-n 50  --follow  --json')}
    doctor               Check key, connectivity and Claude Code setup
    env                  Print env vars for Claude Code   ${c.gray('--shell bash|zsh|fish|powershell|cmd  --claude-json')}
    statusline           One-line status for Claude Code   ${c.gray('--install  --no-color')}
    dashboard            Open the dashboard in your browser
    test-alert           Send a test notification to every channel
    config path|show     Where the config lives / print it (no secrets)

  ${c.bold('Quick start')}
    ollama-guard init
    ollama-guard start --open
    ${c.gray('# then, in the terminal where you run claude:')}
    ollama-guard env

  ${c.gray('Docs: README.md · docs/daily-usage-guide.md')}
`;

async function main(argv: string[]): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  if (flags.version || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  const cfgOrDefault = () => (configExists() ? loadConfig() : defaultConfig());

  switch (cmd) {
    case 'init':
      await runInit({ nonInteractive: Boolean(flags.yes || flags['non-interactive']) });
      return 0;
    case 'start':
    case 'serve':
      await runStart({
        port: flags.port ? Number(flags.port) : undefined,
        host: typeof flags.host === 'string' ? flags.host : undefined,
        detach: Boolean(flags.detach || flags.d),
        open: Boolean(flags.open),
      });
      return -1; // keep running
    case 'stop':
      await runStop();
      return 0;
    case 'status':
      await runStatus({ json: Boolean(flags.json) });
      return 0;
    case 'logs':
      await runLogs({ n: Number(flags.n ?? flags.lines ?? 30) || 30, follow: Boolean(flags.follow), json: Boolean(flags.json) });
      return 0;
    case 'doctor':
      return runDoctor();
    case 'env': {
      const cfg = cfgOrDefault();
      runEnv(cfg, await loadSecrets(cfg), {
        shell: typeof flags.shell === 'string' ? flags.shell : undefined,
        claudeJson: Boolean(flags['claude-json']),
      });
      return 0;
    }
    case 'statusline':
    case 'status-line':
      if (flags.install) {
        console.log(
          `${sym.ok()} Status line added to ${installStatusline()} ${c.gray('(backup saved as settings.json.bak-ollama-guard)')}`,
        );
        console.log(c.gray('  Restart Claude Code to see it.'));
        return 0;
      }
      await runStatusline({ color: flags.color !== false && !process.env.NO_COLOR });
      return 0;
    case 'dashboard':
    case 'open': {
      const cfg = cfgOrDefault();
      const url = `${guardUrl(cfg.server.host, cfg.server.port)}/dashboard`;
      if (!(await fetchStatus(cfg.server.host, cfg.server.port))) {
        console.log(`${sym.warn()} Not running. Start it with ${c.bold('ollama-guard start --open')}.`);
        return 1;
      }
      openInBrowser(url);
      console.log(`${sym.ok()} Opening ${c.cyan(url)}`);
      return 0;
    }
    case 'test-alert': {
      const cfg = cfgOrDefault();
      const running = await fetchStatus(cfg.server.host, cfg.server.port);
      let results: Array<{ channel: string; ok: boolean; error?: string }>;
      if (running) {
        const res = await fetch(`${guardUrl(cfg.server.host, cfg.server.port)}/api/guard/alerts/test`, {
          method: 'POST',
          headers: { 'x-ollama-guard': '1' },
        });
        results = ((await res.json()) as { results: typeof results }).results;
      } else {
        results = await dispatchAlert(
          { kind: 'test', level: 'info', title: 'Test alert', message: 'Ollama Guard can reach you here.', at: new Date().toISOString() },
          cfg,
          await loadSecrets(cfg),
        );
      }
      if (!results.length) console.log(`${sym.warn()} No alert channels are enabled.`);
      for (const r of results) console.log(`${r.ok ? sym.ok() : sym.fail()} ${r.channel}${r.error ? c.gray(`  ${r.error}`) : ''}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case 'config': {
      const sub = positional[0] ?? 'show';
      if (sub === 'path') {
        console.log(paths.config);
        return 0;
      }
      if (sub === 'show') {
        console.log(JSON.stringify(cfgOrDefault(), null, 2));
        return 0;
      }
      console.error(`Unknown: config ${sub}. Use "config path" or "config show".`);
      return 1;
    }
    default:
      console.error(`${sym.fail()} Unknown command "${cmd}". Run ${c.bold('ollama-guard --help')}.`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError)
      console.error(`${sym.fail()} ${err.message}\n  ${c.gray(`Edit ${paths.config} or rerun \`ollama-guard init\`.`)}`);
    else console.error(`${sym.fail()} ${(err as Error).message ?? String(err)}`);
    process.exitCode = 1;
  });
